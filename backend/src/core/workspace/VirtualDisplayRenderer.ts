/**
 * VirtualDisplayRenderer — draws Chrome pages into the virtual display
 * framebuffers.
 *
 * The pipeline, per frame:
 *
 *   1. `Page.captureScreenshot` on a page this renderer created, sized to the
 *      display via `Emulation.setDeviceMetricsOverride` (so the capture is
 *      pixel-exact `width x height`).
 *   2. The returned base64 PNG is decoded to raw RGBA (`PngDecoder`, zlib only).
 *   3. RGBA is emitted on the `frame` event and simultaneously swizzled to
 *      BGRA and pushed into the offscreen framebuffer via `sendFrameToDisplay`.
 *      `getActiveDisplays().hasContent` then reports true for real pixels, so
 *      vision/OCR pipelines reading `VirtualDisplayManager.capture()` see the
 *      page rather than a blank buffer.
 *
 * Privacy invariants:
 *   - The renderer only ever screenshots targets it created itself. It never
 *     attaches to, or captures, tabs the user already had open.
 *   - It never navigates anywhere on its own; `startUrl` defaults to a static
 *     inline placeholder, and a `canCapture` hook lets the caller veto a
 *     display (consent / privacy guard) before any pixels leave the renderer.
 *
 * Scheduling:
 *   - The active ("focused") display renders at its configured FPS (60 by
 *     default); every other display renders at `idleFps` so a multi-display
 *     swarm does not saturate the CDP connection.
 *   - Renders are non-overlapping per display — a slow capture skips its tick
 *     instead of queueing, so back-pressure never turns into unbounded latency.
 *
 * Performance note (measured, 640x360 headless Chrome over CDP):
 *   `Page.captureScreenshot` is a full round-trip that re-rasterises the
 *   surface and PNG-encodes it on the browser side — roughly 25-40ms per
 *   frame, so the practical ceiling is ~10-25fps rather than 60, and it drops
 *   with resolution. The loop is scheduled at the configured FPS and simply
 *   skips ticks it cannot service, so raising displayFps above the ceiling
 *   costs CPU without adding frames. Reaching a true 60fps would need a
 *   continuous surface stream (e.g. CDP screencast frames) rather than
 *   per-frame capture.
 */

import EventEmitter from 'eventemitter3';
import * as http from 'http';
import { VirtualDisplayManager, VirtualDisplay } from './VirtualDisplayManager';
import { CdpSession, CdpTarget } from './CdpSession';
import { decodePng, resampleNearest, rgbaToBgra, DecodedImage } from './PngDecoder';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';
import * as native from '../../native/win32/VirtualDisplayNative';

export interface VirtualDisplayFrame {
  displayId: number;
  width: number;
  height: number;
  /** Freshly decoded, row-major RGBA. Safe to retain. */
  rgba: Buffer;
  /**
   * BGRA as written to the framebuffer. This is a per-display scratch buffer
   * that is overwritten on the next frame — copy it if you need to keep it.
   */
  bgra: Buffer;
  /** Wire-ready PNG (what `Page.captureScreenshot` returned). */
  png: Buffer;
  timestamp: number;
  sequence: number;
  /** True when this display is the focused one. */
  active: boolean;
}

export interface VirtualDisplayRendererConfig {
  /** Chrome DevTools port. Defaults to AgentDesktop's 9223. */
  cdpPort?: number;
  cdpHost?: string;
  /** Page opened per display. Must be a static URL — the renderer never navigates. */
  startUrl?: string;
  /** FPS for displays that are not focused. Defaults to 2. */
  idleFps?: number;
  /** Optional veto, consulted once per frame. Return false to skip the capture. */
  canCapture?: (displayId: number) => Promise<boolean> | boolean;
  /** Follow `display:created` / `display:destroyed` on the event bus. Default true. */
  autoAttach?: boolean;
  /** Attempts to reach the CDP endpoint before giving up on the initial attach. */
  connectRetries?: number;
  connectRetryDelayMs?: number;
  /** Screenshot call timeout. Default 10s — a hung tab must not stall the loop. */
  callTimeoutMs?: number;
}

export interface VirtualDisplayRenderState {
  displayId: number;
  /** CDP target id of the page this renderer opened for the display. */
  targetId: string;
  width: number;
  height: number;
  targetFps: number;
  attached: boolean;
  hasContent: boolean;
  framesRendered: number;
  framesSkipped: number;
  lastFrameAt: number | null;
  lastError: string | null;
  url: string;
}

export interface VirtualDisplayRendererState {
  running: boolean;
  cdpConnected: boolean;
  cdpPort: number;
  activeDisplayId: number | null;
  totalFrames: number;
  displays: VirtualDisplayRenderState[];
}

export type VirtualDisplayRendererEvents = {
  frame: (frame: VirtualDisplayFrame) => void;
  focus: (displayId: number) => void;
  attached: (displayId: number) => void;
  detached: (displayId: number) => void;
  error: (displayId: number, err: Error) => void;
  started: () => void;
  stopped: () => void;
};

const DEFAULTS = {
  cdpPort: 9223,
  cdpHost: '127.0.0.1',
  idleFps: 2,
  connectRetries: 5,
  connectRetryDelayMs: 500,
  callTimeoutMs: 10000,
};

/** Lowest loop cadence we bother with — 4ms ≈ 250Hz, well past any sane FPS. */
const MIN_TICK_MS = 4;

interface DisplaySession {
  id: number;
  targetId: string;
  session: CdpSession;
  width: number;
  height: number;
  fps: number;
  pageReady: boolean;
  /** True while a capture is in flight, so ticks never stack up. */
  inFlight: boolean;
  lastAttemptAt: number;
  lastFrameAt: number | null;
  framesRendered: number;
  framesSkipped: number;
  errors: number;
  lastError: string | null;
  /** Retained so PreviewStreamer / API callers can fetch the newest frame. */
  lastRgba: Buffer | null;
  lastPng: Buffer | null;
  lastBgra: Buffer | null;
  /** Reused BGRA scratch — avoids an 8MB allocation per frame at 1080p. */
  bgraScratch: Buffer | null;
  url: string;
}

export class VirtualDisplayRenderer extends EventEmitter<VirtualDisplayRendererEvents> {
  private displays: VirtualDisplayManager;
  private config: Required<Omit<VirtualDisplayRendererConfig, 'canCapture'>> & {
    canCapture?: VirtualDisplayRendererConfig['canCapture'];
  };
  private sessions = new Map<number, DisplaySession>();
  /** Guards against a concurrent double-attach opening two tabs for one display. */
  private attaching = new Set<number>();
  private running = false;
  private cdpConnected = false;
  private activeDisplayId: number | null = null;
  private totalFrames = 0;
  private loopPromise: Promise<void> | null = null;
  private lastHealCheckAt = 0;

  private readonly onDisplayCreated = (id: number): void => {
    void this.attachDisplay(id);
  };
  private readonly onDisplayDestroyed = (id: number): void => {
    void this.detachDisplay(id);
  };

  constructor(displays: VirtualDisplayManager, config: VirtualDisplayRendererConfig = {}) {
    super();
    this.displays = displays;
    this.config = {
      cdpPort: config.cdpPort ?? DEFAULTS.cdpPort,
      cdpHost: config.cdpHost ?? DEFAULTS.cdpHost,
      startUrl: config.startUrl ?? '',
      idleFps: Math.max(1, config.idleFps ?? DEFAULTS.idleFps),
      autoAttach: config.autoAttach ?? true,
      connectRetries: config.connectRetries ?? DEFAULTS.connectRetries,
      connectRetryDelayMs: config.connectRetryDelayMs ?? DEFAULTS.connectRetryDelayMs,
      callTimeoutMs: config.callTimeoutMs ?? DEFAULTS.callTimeoutMs,
      canCapture: config.canCapture,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /**
   * Attach to CDP and begin rendering every active display.
   *
   * Never throws: if the browser is not up yet (or never comes up), the
   * renderer keeps retrying in the background and the caller keeps a working
   * Desktop 2 in browser-only mode. `display:created` events still attach new
   * displays as they appear.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.config.autoAttach) {
      eventBus.on('display:created', this.onDisplayCreated);
      eventBus.on('display:destroyed', this.onDisplayDestroyed);
    }

    const connected = await this.tryConnect();
    if (!connected) {
      getLogger().warn(
        { port: this.config.cdpPort },
        'VirtualDisplayRenderer: CDP not reachable yet — retrying in the background',
      );
    } else {
      for (const display of this.displays.getActiveDisplays()) {
        await this.attachDisplay(display.id);
      }
    }

    this.loopPromise = this.loop();
    this.emit('started');
    getLogger().info(
      { port: this.config.cdpPort, cdpConnected: this.cdpConnected, startUrl: this.config.startUrl },
      'VirtualDisplayRenderer started',
    );
  }

  async stop(): Promise<void> {
    if (!this.running && this.sessions.size === 0) return;
    this.running = false;

    if (this.config.autoAttach) {
      eventBus.off('display:created', this.onDisplayCreated);
      eventBus.off('display:destroyed', this.onDisplayDestroyed);
    }

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    // detachDisplay() deletes as it goes; Map iterators tolerate removing the
    // entry they are currently on.
    for (const id of this.sessions.keys()) {
      await this.detachDisplay(id);
    }

    this.cdpConnected = false;
    this.activeDisplayId = null;
    this.emit('stopped');
    getLogger().info('VirtualDisplayRenderer stopped');
  }

  // ─── Focus ─────────────────────────────────────────────────

  /**
   * Mark a display as the focused one. It renders at its full FPS and gets
   * brought to front so the page sees real focus styles; every other display
   * drops to `idleFps`.
   */
  async setActiveDisplay(displayId: number | null): Promise<void> {
    if (this.activeDisplayId === displayId) return;

    const previous = this.activeDisplayId;
    this.activeDisplayId = displayId;
    this.emit('focus', displayId ?? -1);
    getLogger().debug({ previous, active: displayId }, 'VirtualDisplayRenderer focus changed');

    const target = displayId !== null ? this.sessions.get(displayId) : undefined;
    if (target && target.pageReady) {
      try {
        await target.session.call('Page.bringToFront');
      } catch (e) {
        this.warn(target.id, e as Error, 'Page.bringToFront');
      }
    }
  }

  getActiveDisplayId(): number | null {
    return this.activeDisplayId;
  }

  // ─── Rendering ─────────────────────────────────────────────

  /** Render exactly one frame for a display, on demand. */
  async renderDisplay(displayId: number): Promise<VirtualDisplayFrame | null> {
    // Attach lazily: the display may predate the renderer, or the
    // display:created event may not have been delivered yet.
    if (!this.sessions.has(displayId) && this.running && this.cdpConnected) {
      await this.attachDisplay(displayId);
    }
    const session = this.sessions.get(displayId);
    if (!session) return null;
    return this.capture(session);
  }

  /** Render one frame for every active display, concurrently. */
  async renderAll(): Promise<VirtualDisplayFrame[]> {
    const ids = this.displays.getActiveDisplays().map(d => d.id);
    const frames = await Promise.all(ids.map(id => this.renderDisplay(id)));
    return frames.filter((f): f is VirtualDisplayFrame => f !== null);
  }

  /**
   * Point a display's page at a URL and wait for its first frame.
   *
   * This is the only way content ever reaches a display: the renderer does not
   * navigate on its own, and it only ever touches the pages it created. The
   * caller is responsible for the consent and privacy checks.
   */
  async navigate(displayId: number, url: string): Promise<VirtualDisplayFrame | null> {
    const session = this.sessions.get(displayId);
    if (!session) throw new Error(`Display ${displayId} is not attached to a renderer page`);
    if (!session.pageReady) throw new Error(`Display ${displayId} page is not ready`);

    await session.session.call('Page.navigate', { url });
    session.url = url;
    // `Page.navigate` resolves when the navigation is committed, not when the
    // document has painted — let the first capture fail rather than racing it.
    return this.capture(session);
  }

  /** Newest frame for a display, if one has been rendered. */
  getLatestFrame(displayId: number): VirtualDisplayFrame | null {
    const s = this.sessions.get(displayId);
    if (!s || !s.lastRgba || !s.lastBgra || !s.lastPng) return null;
    return {
      displayId,
      width: s.width,
      height: s.height,
      rgba: s.lastRgba,
      bgra: s.lastBgra,
      png: s.lastPng,
      timestamp: s.lastFrameAt ?? 0,
      sequence: s.framesRendered,
      active: this.activeDisplayId === displayId,
    };
  }

  /**
   * Newest PNG for a display — the format PreviewStreamer (9090) and the PWA
   * expect, so the virtual display can be streamed verbatim.
   */
  getLatestPng(displayId: number): Buffer | null {
    return this.sessions.get(displayId)?.lastPng ?? null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getState(): VirtualDisplayRendererState {
    return {
      running: this.running,
      cdpConnected: this.cdpConnected,
      cdpPort: this.config.cdpPort,
      activeDisplayId: this.activeDisplayId,
      totalFrames: this.totalFrames,
      displays: Array.from(this.sessions.values()).map(s => ({
        displayId: s.id,
        targetId: s.targetId,
        width: s.width,
        height: s.height,
        targetFps: this.fpsFor(s),
        attached: s.pageReady,
        hasContent: s.framesRendered > 0,
        framesRendered: s.framesRendered,
        framesSkipped: s.framesSkipped,
        lastFrameAt: s.lastFrameAt,
        lastError: s.lastError,
        url: s.url,
      })),
    };
  }

  // ─── Internals: CDP plumbing ───────────────────────────────

  private async tryConnect(): Promise<boolean> {
    for (let attempt = 0; attempt < this.config.connectRetries; attempt++) {
      try {
        await this.httpGet('/json/version');
        this.cdpConnected = true;
        return true;
      } catch {
        if (attempt + 1 < this.config.connectRetries) {
          await this.sleep(this.config.connectRetryDelayMs);
        }
      }
    }
    this.cdpConnected = false;
    return false;
  }

  private async attachDisplay(displayId: number): Promise<void> {
    if (!this.running) return;
    if (this.sessions.has(displayId)) return;
    // Two callers can race here (a display:created event and an on-demand
    // renderDisplay). Without this guard both would pass the `has` check and
    // open two tabs, leaking one.
    if (this.attaching.has(displayId)) return;
    this.attaching.add(displayId);

    try {
      const info = this.displays.getDisplay(displayId);
      if (!info) return;

      if (!this.cdpConnected) {
        this.cdpConnected = await this.tryConnect();
      }
      if (!this.cdpConnected) {
        getLogger().debug({ displayId }, 'VirtualDisplayRenderer: no CDP, skipping attach');
        return;
      }

      const session = await this.createSession(displayId, info);
      this.sessions.set(displayId, session);

      // First display attached becomes the focus unless one is already chosen.
      if (this.activeDisplayId === null) {
        await this.setActiveDisplay(displayId);
      }

      this.emit('attached', displayId);
      getLogger().info(
        { displayId, targetId: session.targetId, width: session.width, height: session.height, url: session.url },
        'VirtualDisplayRenderer: display page attached',
      );
    } catch (e) {
      this.warn(displayId, e as Error, 'attachDisplay');
    } finally {
      this.attaching.delete(displayId);
    }
  }

  private async createSession(displayId: number, info: VirtualDisplay): Promise<DisplaySession> {
    const target = await this.newTarget('about:blank');
    const session = new CdpSession(target.id, target.webSocketDebuggerUrl, this.config.callTimeoutMs);
    await session.connect();
    session.listen();

    await session.call('Page.enable');
    await session.call('Runtime.enable');
    // Exact viewport = exact framebuffer. deviceScaleFactor 1 keeps the
    // capture 1:1 with the display's pixel grid.
    await session.call('Emulation.setDeviceMetricsOverride', {
      width: info.width,
      height: info.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: info.width,
      screenHeight: info.height,
    });

    let url = 'about:blank';
    if (this.config.startUrl) {
      try {
        await session.call('Page.navigate', { url: this.config.startUrl });
        url = this.config.startUrl;
      } catch (e) {
        this.warn(displayId, e as Error, 'Page.navigate (keeping about:blank)');
      }
    } else {
      // A labelled placeholder beats a blank white rectangle: it proves the
      // framebuffer is live to anyone watching the preview stream.
      await this.setPlaceholder(session, displayId).catch(() => { /* best effort */ });
    }

    return {
      id: displayId,
      targetId: target.id,
      session,
      width: info.width,
      height: info.height,
      fps: info.fps,
      pageReady: true,
      inFlight: false,
      lastAttemptAt: 0,
      lastFrameAt: null,
      framesRendered: 0,
      framesSkipped: 0,
      errors: 0,
      lastError: null,
      lastRgba: null,
      lastPng: null,
      lastBgra: null,
      bgraScratch: null,
      url,
    };
  }

  /**
   * Replace the blank document with a static placeholder via
   * `Page.setDocumentContent`. Deliberately avoids `Runtime.evaluate` — this
   * renderer never executes JavaScript in the page, which keeps it out of the
   * consent/evaluate-guard code path entirely.
   */
  private async setPlaceholder(session: CdpSession, displayId: number): Promise<void> {
    const tree = await session.call<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) return;

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#0f1115;color:#e6e6e6;
        font:600 28px/1.4 "Segoe UI",system-ui,sans-serif;
        display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
      .n{font-size:64px;letter-spacing:-2px}
      .m{color:#7c8595;font-weight:400;font-size:18px}
    </style></head><body>
      <div class="n">Display ${displayId}</div>
      <div class="m">Umbra OS &middot; virtual desktop</div>
    </body></html>`;

    await session.call('Page.setDocumentContent', { frameId, html });
  }

  private async detachDisplay(displayId: number): Promise<void> {
    const session = this.sessions.get(displayId);
    if (!session) return;
    this.sessions.delete(displayId);

    session.pageReady = false;
    session.session.close();

    // Only ever close pages this renderer opened.
    try {
      await this.httpGet(`/json/close/${encodeURIComponent(session.targetId)}`);
    } catch (e) {
      this.warn(displayId, e as Error, 'close target');
    }

    if (this.activeDisplayId === displayId) {
      const next = this.sessions.keys().next();
      this.activeDisplayId = next.done ? null : next.value;
    }

    this.emit('detached', displayId);
    getLogger().info({ displayId, targetId: session.targetId }, 'VirtualDisplayRenderer: display page detached');
  }

  // ─── Internals: frame loop ────────────────────────────────

  private async loop(): Promise<void> {
    while (this.running) {
      const startedAt = Date.now();
      try {
        this.tick();
      } catch (e) {
        getLogger().warn({ err: (e as Error).message }, 'VirtualDisplayRenderer: loop tick failed');
      }

      // Self-heal: pick up displays that have no page (browser was started
      // after us, a tab crashed, a recovery raced an attach), and re-probe CDP
      // when we have nothing attached at all. The 1s floor keeps a dead
      // endpoint from turning into a tight reconnect storm.
      if (startedAt - this.lastHealCheckAt >= 1000) {
        this.lastHealCheckAt = startedAt;
        this.healUnattachedDisplays();
      }

      const elapsed = Date.now() - startedAt;
      const tick = this.tickIntervalMs();
      await this.sleep(Math.max(1, tick - elapsed));
    }
  }

  /**
   * One pass over the displays, firing off any capture that is due.
   * Deliberately not awaited: a 1080p capture takes tens of milliseconds and
   * must not delay the other displays' ticks.
   */
  private tick(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.pageReady || session.inFlight) continue;
      const interval = 1000 / this.fpsFor(session);
      if (now - session.lastAttemptAt < interval) continue;

      session.lastAttemptAt = now;
      session.inFlight = true;
      void this.capture(session)
        .catch((e: Error) => this.warn(session.id, e, 'tick capture'))
        .finally(() => { session.inFlight = false; });
    }
  }

  private fpsFor(session: DisplaySession): number {
    if (this.activeDisplayId === null) return session.fps;
    return this.activeDisplayId === session.id ? session.fps : this.config.idleFps;
  }

  /**
   * Attach a page for any active display that is missing one. Fire-and-forget
   * so the loop keeps its cadence; `attachDisplay` is itself re-entrant-safe.
   */
  private healUnattachedDisplays(): void {
    const orphans = this.displays
      .getActiveDisplays()
      .filter(d => !this.sessions.has(d.id) && !this.attaching.has(d.id))
      .map(d => d.id);
    if (orphans.length === 0 && this.sessions.size > 0) return;

    if (!this.cdpConnected) {
      void this.tryConnect().then(ok => {
        if (!ok) return;
        for (const id of this.displays.getActiveDisplays().map(d => d.id)) void this.attachDisplay(id);
      });
      return;
    }
    for (const id of orphans) void this.attachDisplay(id);
  }

  private tickIntervalMs(): number {
    let min = 100;
    for (const session of this.sessions.values()) {
      min = Math.min(min, 1000 / this.fpsFor(session));
    }
    return Math.max(MIN_TICK_MS, min);
  }

  // ─── Internals: capture ───────────────────────────────────

  private async capture(session: DisplaySession): Promise<VirtualDisplayFrame | null> {
    if (!session.pageReady) return null;
    if (this.config.canCapture && !(await this.config.canCapture(session.id))) {
      session.framesSkipped++;
      return null;
    }

    let png: Buffer;
    try {
      const res = await session.session.call<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      if (!res?.data) throw new Error('captureScreenshot returned no data');
      png = Buffer.from(res.data, 'base64');
    } catch (e) {
      this.warn(session.id, e as Error, 'captureScreenshot');
      // A dropped socket or a closed tab needs a fresh page, not a retry storm.
      if (this.isFatalSessionError(e as Error)) {
        session.pageReady = false;
        void this.recover(session);
      }
      return null;
    }

    let image: DecodedImage;
    try {
      image = decodePng(png);
    } catch (e) {
      this.warn(session.id, e as Error, 'decodePng');
      return null;
    }

    // The framebuffer has a fixed byte size; coerce any dimension drift.
    if (image.width !== session.width || image.height !== session.height) {
      image = resampleNearest(image, session.width, session.height);
    }

    const expected = session.width * session.height * 4;
    if (!session.bgraScratch || session.bgraScratch.length !== expected) {
      session.bgraScratch = Buffer.allocUnsafe(expected);
    }
    const bgra = rgbaToBgra(image.data, session.bgraScratch);

    const pushed = await this.pushToDisplay(session, bgra);
    if (!pushed) {
      this.warn(session.id, new Error('frame not pushed to framebuffer'), 'sendFrameToDisplay');
      return null;
    }

    session.framesRendered++;
    session.lastFrameAt = Date.now();
    session.lastRgba = image.data;
    session.lastPng = png;
    // Snapshot the scratch so getLatestFrame() does not hand out a buffer that
    // the next frame is about to overwrite.
    session.lastBgra = pushed;
    this.totalFrames++;

    const frame: VirtualDisplayFrame = {
      displayId: session.id,
      width: image.width,
      height: image.height,
      rgba: image.data,
      bgra: pushed,
      png,
      timestamp: session.lastFrameAt,
      sequence: session.framesRendered,
      active: this.activeDisplayId === session.id,
    };
    this.emit('frame', frame);
    return frame;
  }

  /**
   * Copy the frame into the display's offscreen framebuffer.
   * Returns the exact buffer now owned by the framebuffer (a copy, so the
   * frame handed to listeners stays valid).
   */
  private async pushToDisplay(session: DisplaySession, bgra: Buffer): Promise<Buffer | null> {
    const handle = this.displays.getDisplay(session.id)?.nativeHandle ?? null;
    if (handle === null) {
      // No native handle (display creation fell back to a virtual buffer).
      // The frame is still real content for listeners and the preview stream.
      return Buffer.from(bgra);
    }
    try {
      await native.sendFrameToDisplay(handle, bgra);
      return Buffer.from(bgra);
    } catch (e) {
      getLogger().debug(
        { displayId: session.id, err: (e as Error).message },
        'VirtualDisplayRenderer: sendFrameToDisplay failed (frame kept in-memory)',
      );
      return null;
    }
  }

  private isFatalSessionError(err: Error): boolean {
    return /not connected|connection closed|socket error|Target closed|session closed/i.test(err.message);
  }

  /** Rebuild a display's page after a fatal CDP error, with a small backoff. */
  private async recover(session: DisplaySession): Promise<void> {
    const id = session.id;
    try {
      session.session.close();
      try { await this.httpGet(`/json/close/${encodeURIComponent(session.targetId)}`); } catch { /* gone */ }
      this.sessions.delete(id);
    } catch (e) {
      this.warn(id, e as Error, 'recover teardown');
      return;
    }

    await this.sleep(500);
    if (!this.running) return;
    this.cdpConnected = await this.tryConnect();
    if (this.cdpConnected) await this.attachDisplay(id);
  }

  private warn(displayId: number, err: Error, where: string): void {
    this.emit('error', displayId, err);
    getLogger().warn(
      { displayId, err: err.message, where },
      'VirtualDisplayRenderer: render error',
    );
  }

  // ─── Internals: HTTP ──────────────────────────────────────

  private base(): string {
    return `http://${this.config.cdpHost}:${this.config.cdpPort}`;
  }

  private httpGet(path: string): Promise<string> {
    return this.request('GET', path);
  }

  private newTarget(url: string): Promise<CdpTarget> {
    return this.request('PUT', `/json/new?${encodeURIComponent(url)}`)
      .then(body => {
        const t = JSON.parse(body) as CdpTarget;
        if (!t?.webSocketDebuggerUrl) throw new Error('new target has no webSocketDebuggerUrl');
        return t;
      });
  }

  private request(method: 'GET' | 'PUT', path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${this.base()}${path}`,
        { method, headers: { Host: `${this.config.cdpHost}:${this.config.cdpPort}` } },
        res => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', c => { data += c; });
          res.on('end', () => {
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`CDP ${method} ${path} → ${res.statusCode}: ${data.slice(0, 200)}`));
            } else {
              resolve(data);
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(this.config.callTimeoutMs, () => {
        req.destroy(new Error(`CDP ${method} ${path} timed out`));
      });
      req.end();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
