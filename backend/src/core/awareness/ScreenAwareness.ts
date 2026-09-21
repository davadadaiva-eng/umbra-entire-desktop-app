/**
 * ScreenAwareness — Umbra's "always watching" eye. It keeps the current screen
 * (screenshot + OCR + foreground window + cursor position) and answers
 * questions about it, so you can ask mid-task: "what's on my screen?",
 * "help me finish this", "what does this error mean?", etc.
 *
 * Two modes:
 *  - on-demand: `snapshot()` / `ask()` capture now and answer.
 *  - watching:  `startWatching()` keeps the latest frame + cursor trail live in
 *    memory (and emits `screen:update` / `screen:cursor` events), so a mid-task
 *    ask is answered instantly from the already-current view — Umbra is always
 *    seeing your screen and following your cursor.
 *
 * The answer is grounded in what is actually visible: the screenshot goes to
 * the vision model (with the OCR text as a text-only fallback so even a local
 * text model can answer from the screen text), plus the foreground window and
 * the cursor position/trail so the model knows exactly what you're pointing at.
 */
import { LLMConnector, LLMMessage } from '../agent/LLMConnector';
import { ScreenReader } from '../vision/ScreenReader';
import { getCursorPos, getForegroundWindowInfo, WindowInfo, CursorPos } from '../../native/win32/WindowNative';
import { captureScreenPng, ScreenPng } from '../../native/win32/ScreenCaptureNative';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';

export interface ScreenSnapshot {
  window: string;
  appName: string;
  cursor: CursorPos;
  ocrText: string;
  width: number;
  height: number;
  capturedAt: number;
}

export interface CursorTrailPoint {
  x: number;
  y: number;
  at: number;
}

export type AwarenessIntent = 'answer' | 'help' | 'finish';

export interface AwarenessAnswer {
  answer: string;
  intent: AwarenessIntent;
  snapshot: ScreenSnapshot;
  usedVision: boolean;
}

export interface ScreenAwarenessOptions {
  llm: LLMConnector;
  screenReader: ScreenReader;
  capture?: () => Promise<ScreenPng | null>;
  getWindow?: () => WindowInfo;
  getCursor?: () => CursorPos;
  /** Live-sample interval for startWatching() (default 1000ms). */
  watchIntervalMs?: number;
  /** Keep a cursor trail for "what are you pointing at" context (default true). */
  followCursor?: boolean;
  /** Cursor must move this many px (squared) before a new trail point is kept. */
  cursorMoveThreshold?: number;
}

const INTENT_PROMPTS: Record<AwarenessIntent, string> = {
  answer:
    'Answer the user\'s question using ONLY what is visible on their screen (the screenshot and the OCR text below). Be concise and concrete. If the answer is not on the screen, say so and offer the most helpful next step you can infer from the screen.',
  help:
    'The user is stuck mid-task and asked for help finishing it. Look at their screen and tell them exactly what to do next: the concrete next action(s), any text to type, button to click, or fix to apply. Be specific to what is on screen.',
  finish:
    'The user is mid-task and asked you to finish it (or take over). Look at their screen, figure out where they are in the task, and either do the concrete next step for them or give the exact steps to complete it. Be specific to what is on screen.',
};

const MAX_TRAIL = 40;

interface CapturedView {
  snapshot: ScreenSnapshot;
  imageBase64: string | null;
}

export class ScreenAwareness {
  private llm: LLMConnector;
  private screenReader: ScreenReader;
  private capture: () => Promise<ScreenPng | null>;
  private getWindow: () => WindowInfo;
  private getCursor: () => CursorPos;
  private watchIntervalMs: number;
  private followCursor: boolean;
  private cursorMoveThresholdSq: number;

  private watching = false;
  private watchTimer?: NodeJS.Timeout;
  private lastView: CapturedView | null = null;
  private trail: CursorTrailPoint[] = [];
  private lastCursor: CursorPos | null = null;

  constructor(options: ScreenAwarenessOptions) {
    this.llm = options.llm;
    this.screenReader = options.screenReader;
    this.capture = options.capture ?? captureScreenPng;
    this.getWindow = options.getWindow ?? getForegroundWindowInfo;
    this.getCursor = options.getCursor ?? getCursorPos;
    this.watchIntervalMs = options.watchIntervalMs ?? 1000;
    this.followCursor = options.followCursor ?? true;
    const threshold = options.cursorMoveThreshold ?? 4;
    this.cursorMoveThresholdSq = threshold * threshold;
  }

  get isWatching(): boolean {
    return this.watching;
  }

  /** Begin continuously sampling the screen + cursor. Idempotent. */
  startWatching(intervalMs?: number): void {
    if (this.watching) return;
    this.watching = true;
    const interval = intervalMs ?? this.watchIntervalMs;
    void this.refresh();
    this.watchTimer = setInterval(() => {
      void this.refresh();
    }, interval);
    getLogger().info({ intervalMs: interval }, 'Screen awareness watch started');
  }

  stopWatching(): void {
    this.watching = false;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    getLogger().info('Screen awareness watch stopped');
  }

  /** Most recent live view (from the watch loop or the last snapshot/ask). */
  latest(): CapturedView | null {
    return this.lastView;
  }

  /** Recent cursor positions, oldest → newest (used to "follow" the cursor). */
  cursorTrail(): CursorTrailPoint[] {
    return this.trail.slice();
  }

  /** Capture the current screen state (image + OCR + window + cursor). */
  async snapshot(): Promise<CapturedView | null> {
    const shot = await this.safeCapture();
    if (!shot) return null;

    const window = this.safeWindow();
    const cursor = this.safeCursor();
    let ocrText = '';
    try {
      ocrText = (await this.screenReader.ocrImage(shot.buffer)).slice(0, 8000);
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'Screen awareness OCR failed');
    }

    const snapshot: ScreenSnapshot = {
      window: window.windowTitle || '',
      appName: window.appName || 'unknown',
      cursor,
      ocrText,
      width: shot.width,
      height: shot.height,
      capturedAt: shot.capturedAt,
    };

    const view: CapturedView = { snapshot, imageBase64: shot.buffer.toString('base64') };
    this.lastView = view;
    this.recordCursor(cursor);
    return view;
  }

  /** One watch tick: capture the live view and announce it on the event bus. */
  async refresh(): Promise<void> {
    const view = await this.snapshot();
    if (!view) return;
    eventBus.emit('screen:update', {
      window: view.snapshot.window,
      appName: view.snapshot.appName,
      cursor: view.snapshot.cursor,
      width: view.snapshot.width,
      height: view.snapshot.height,
      ocrChars: view.snapshot.ocrText.length,
      capturedAt: view.snapshot.capturedAt,
    });
  }

  /**
   * Ask a question about (or ask for help finishing) what's on screen. When
   * watching, this answers from the already-live view so it is instant.
   */
  async ask(question: string, intent: AwarenessIntent = 'answer'): Promise<AwarenessAnswer> {
    const normalizedIntent: AwarenessIntent = intent === 'finish' ? 'finish' : intent === 'help' ? 'help' : 'answer';
    const captured = (this.watching && this.lastView) ? this.lastView : await this.snapshot();
    if (!captured) {
      return {
        answer: 'I could not capture your screen right now (screen capture is unavailable).',
        intent: normalizedIntent,
        snapshot: {
          window: '', appName: 'unknown', cursor: { x: 0, y: 0 },
          ocrText: '', width: 0, height: 0, capturedAt: Date.now(),
        },
        usedVision: false,
      };
    }

    const { snapshot, imageBase64 } = captured;
    const trailText = this.trail.slice(-8).map(p => `(${p.x},${p.y})`).join(' → ');
    const contextText = [
      `Foreground app: ${snapshot.appName}`,
      snapshot.window ? `Window title: ${snapshot.window}` : '',
      `Cursor at: (${snapshot.cursor.x}, ${snapshot.cursor.y}) on a ${snapshot.width}x${snapshot.height} screen`,
      trailText ? `Cursor trail (recent → current): ${trailText}` : '',
      snapshot.ocrText ? `Screen text (OCR):\n${snapshot.ocrText}` : '(no text detected on screen)',
    ].filter(Boolean).join('\n');

    const system = `${INTENT_PROMPTS[normalizedIntent]}\n\nScreen context:\n${contextText}`;

    // Try the vision model first (screenshot + text); fall back to a
    // text-only call so local/vision-less models can still answer from OCR.
    let usedVision = false;
    let content: string;
    if (imageBase64) {
      try {
        content = await this.completeWithImage(system, question, imageBase64);
        usedVision = true;
      } catch (err: any) {
        getLogger().debug({ err: err.message }, 'Vision answer failed — falling back to text-only');
        content = await this.textOnly(system, question);
      }
    } else {
      content = await this.textOnly(system, question);
    }

    return { answer: content, intent: normalizedIntent, snapshot, usedVision };
  }

  private recordCursor(cursor: CursorPos): void {
    if (!this.followCursor) return;
    const moved = !this.lastCursor
      || (cursor.x - this.lastCursor.x) ** 2 + (cursor.y - this.lastCursor.y) ** 2 >= this.cursorMoveThresholdSq;
    if (moved) {
      this.lastCursor = cursor;
      this.trail.push({ x: cursor.x, y: cursor.y, at: Date.now() });
      if (this.trail.length > MAX_TRAIL) this.trail.splice(0, this.trail.length - MAX_TRAIL);
      eventBus.emit('screen:cursor', { x: cursor.x, y: cursor.y });
    }
  }

  private async textOnly(system: string, question: string): Promise<string> {
    const result = await this.llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      'reasoning',
      { temperature: 0.2 },
    );
    return result.content;
  }

  private async completeWithImage(system: string, question: string, imageBase64: string): Promise<string> {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${system}\n\nUser question: ${question}` },
          { type: 'image', image: imageBase64, detail: 'low' },
        ],
      },
    ];
    const result = await this.llm.complete(messages, 'vision', { temperature: 0.2, maxTokens: 800 });
    return result.content;
  }

  private async safeCapture(): Promise<ScreenPng | null> {
    try {
      return await this.capture();
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'Screen capture failed');
      return null;
    }
  }

  private safeWindow(): WindowInfo {
    try {
      return this.getWindow();
    } catch {
      return { appName: 'unknown', windowTitle: '' };
    }
  }

  private safeCursor(): CursorPos {
    try {
      return this.getCursor();
    } catch {
      return { x: 0, y: 0 };
    }
  }
}
