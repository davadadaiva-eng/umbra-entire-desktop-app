/**
 * Live Shadowing — watches the real screen in real time and exposes a
 * take-over API. The shadow engine captures frames (DXGI-backed GDI via
 * ScreenCaptureNative), runs foreground/window detection, and records
 * activity so the agent can jump in ("I'll take it from here") without
 * losing the context of what the user was doing.
 */

import { captureScreenPng, captureWindowPng, CaptureFrame, captureDisplay } from '../../native/win32/ScreenCaptureNative';
import { getForegroundWindowInfo } from '../../native/win32/WindowNative';
import { getLogger } from '../Logger';

export interface ShadowFrame {
  data: Buffer;
  width: number;
  height: number;
  capturedAt: number;
  window?: string;
}

export interface ShadowActivity {
  activity: string;
  window: string;
  startedAt: number;
  frames: number;
}

export interface TakeOverRequest {
  reason: string;
  durationMs: number;
  window?: string;
}

export interface TakeOverGrant {
  granted: boolean;
  token?: string;
  expiresAt?: number;
  reason?: string;
}

export interface ShadowOptions {
  captureIntervalMs?: number;
  maxFrameRate?: number;
  captureWindow?: boolean;
}

export class LiveShadowEngine {
  private intervalMs: number;
  private captureWindow: boolean;
  private running = false;
  private timer?: NodeJS.Timeout;
  private lastFrames = new Map<string, ShadowFrame>();
  private activity: ShadowActivity[] = [];
  private activeToken?: { token: string; expiresAt: number; reason: string };

  constructor(options: ShadowOptions = {}) {
    this.intervalMs = options.captureIntervalMs ?? 1000;
    this.captureWindow = options.captureWindow ?? false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    getLogger().info('Live shadow engine started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    getLogger().info('Live shadow engine stopped');
  }

  /** Most recent shadow frame for the primary display. */
  async snapshot(): Promise<ShadowFrame | null> {
    const png = await captureScreenPng();
    if (!png) return null;
    const frame: ShadowFrame = {
      data: png.buffer,
      width: png.width,
      height: png.height,
      capturedAt: png.capturedAt,
      window: await this.currentWindow(),
    };
    this.lastFrames.set('primary', frame);
    return frame;
  }

  /** Shadow a specific window by process name or title. */
  async shadowWindow(match: string): Promise<ShadowFrame | null> {
    const buf = await captureWindowPng(match);
    if (!buf) return null;
    const frame: ShadowFrame = { data: buf, width: 0, height: 0, capturedAt: Date.now(), window: match };
    this.lastFrames.set(match, frame);
    return frame;
  }

  async currentWindow(): Promise<string> {
    if (!this.captureWindow) return '';
    try {
      const info = getForegroundWindowInfo();
      return info?.windowTitle || '';
    } catch {
      return '';
    }
  }

  /**
   * Take-over API: an agent (or the reasoning engine) requests control of the screen.
   * Granted unless a takeover is already in flight. A token gates the
   * take-over session and auto-expires.
   */
  requestTakeover(request: TakeOverRequest): TakeOverGrant {
    if (this.activeToken && Date.now() < this.activeToken.expiresAt) {
      return { granted: false, reason: 'Another takeover session is active' };
    }
    const token = `tk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.activeToken = { token, expiresAt: Date.now() + request.durationMs, reason: request.reason };
    getLogger().info({ reason: request.reason, durationMs: request.durationMs }, 'Screen takeover granted');
    return { granted: true, token, expiresAt: this.activeToken.expiresAt };
  }

  isTakeoverActive(token?: string): boolean {
    if (!this.activeToken) return false;
    if (Date.now() >= this.activeToken.expiresAt) {
      this.activeToken = undefined;
      return false;
    }
    return token === undefined || token === this.activeToken.token;
  }

  releaseTakeover(token: string): boolean {
    if (this.activeToken?.token !== token) return false;
    this.activeToken = undefined;
    return true;
  }

  /** Aggregate recent shadow activity for the journal. */
  activitySummary(minutes = 30): ShadowActivity[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.activity.filter(a => a.startedAt >= cutoff);
  }

  private async tick(): Promise<void> {
    try {
      const frame = await captureDisplay(0);
      if (!frame) return;
      const window = await this.currentWindow();
      const key = window || 'primary';
      const existing = this.activity[this.activity.length - 1];
      if (existing && existing.window === key) {
        existing.frames++;
      } else {
        this.activity.push({ activity: 'screen-activity', window: key, startedAt: Date.now(), frames: 1 });
      }
      this.lastFrames.set(key, this.toShadowFrame(frame, window));
    } catch (err) {
      getLogger().debug({ err }, 'Shadow tick failed');
    }
  }

  private toShadowFrame(frame: CaptureFrame, window: string): ShadowFrame {
    return { data: frame.data, width: frame.width, height: frame.height, capturedAt: frame.timestamp, window };
  }
}
