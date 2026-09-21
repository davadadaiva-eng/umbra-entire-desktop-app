/**
 * PushToTalkService — the "hold to talk" capture loop that turns a hotkey
 * press into a task submission.
 *
 * Flow (wired in the composition root):
 *   GlobalHotkey press   → service.start()  → recorder starts capturing
 *   GlobalHotkey release → service.stop()   → recorder stops → STT transcribes
 *     → SkillRouter routes the intent → AgentRuntime.submitTask → spoken ack
 *     ("On it — …" via the injected TTS engine) + beep
 *
 * Every collaborator is injected (recorder, STT, router, submitTask, speak,
 * beep), so the class is fully unit-testable with mocks — no OS audio, no
 * network.
 *
 * The recorder is a small interface on purpose: the meeting loopback recorder
 * satisfies it, and a mic-capture recorder can be swapped in without touching
 * this class.
 */
import { getLogger } from '../Logger';

export interface PushToTalkRecorder {
  start(): Promise<void> | void;
  /** Stop capture and return the recorded audio (empty buffer = nothing heard). */
  stop(): Promise<Buffer> | Buffer;
}

export interface PushToTalkStt {
  transcribe(req: { audio: Buffer; format?: 'wav' | 'webm' }): Promise<{ text: string }>;
}

export interface PushToTalkRouter {
  /** Turn a transcript into a task description; null/undefined → use the raw text. */
  route(input: string): Promise<string | null | undefined> | string | null | undefined;
}

export interface PushToTalkDeps {
  recorder: PushToTalkRecorder;
  stt: PushToTalkStt;
  router: PushToTalkRouter;
  submitTask: (description: string) => Promise<string> | string;
  /**
   * Spoken acknowledgement after a task is submitted (e.g. "On it — …"
   * via the configured TTS engine). Best-effort: failures are logged, never
   * propagated — a TTS outage must not fail the voice command.
   */
  speak?: (text: string) => Promise<unknown> | unknown;
  /** Called after a task is submitted (e.g. a confirmation beep). */
  confirm?: () => void;
  /** Capture-format hint passed to the STT provider (default 'wav'). */
  format?: 'wav' | 'webm';
}

export class PushToTalkService {
  private deps: PushToTalkDeps;
  private capturing = false;

  constructor(deps: PushToTalkDeps) {
    this.deps = deps;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  /** Hotkey pressed — begin capture (no-op while already capturing). */
  async start(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    try {
      await this.deps.recorder.start();
      getLogger().info('Push-to-talk capture started');
    } catch (err) {
      this.capturing = false;
      getLogger().error({ err }, 'Push-to-talk capture failed to start');
    }
  }

  /** Hotkey released — stop, transcribe, route, submit. */
  async stop(): Promise<void> {
    if (!this.capturing) return;
    this.capturing = false;
    try {
      const audio = await this.deps.recorder.stop();
      if (!audio || audio.length === 0) {
        getLogger().debug('Push-to-talk captured no audio — skipping');
        return;
      }
      const result = await this.deps.stt.transcribe({ audio, format: this.deps.format ?? 'wav' });
      const text = (result.text || '').trim();
      if (!text) {
        getLogger().debug('Push-to-talk transcript empty — skipping');
        return;
      }
      // Routing is best-effort: a router outage must not kill the voice path,
      // so fall back to the raw transcript as the task description.
      let description = text;
      try {
        description = (await this.deps.router.route(text)) || text;
      } catch (err) {
        getLogger().warn({ err }, 'Push-to-talk intent routing failed — using raw transcript');
      }
      const taskId = await this.deps.submitTask(description);
      // Spoken acknowledgement closes the voice loop ("tap to listen" hears
      // the assistant answer back, not just a beep). Best-effort by design.
      if (this.deps.speak) {
        try {
          await this.deps.speak(`On it — ${description}`);
        } catch (err) {
          getLogger().warn({ err }, 'Push-to-talk spoken confirmation failed');
        }
      }
      this.deps.confirm?.();
      getLogger().info({ taskId, text: text.slice(0, 120) }, 'Push-to-talk submitted task');
    } catch (err) {
      getLogger().error({ err }, 'Push-to-talk pipeline failed');
    }
  }
}
