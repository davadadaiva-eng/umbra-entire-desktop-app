/**
 * VibeVoiceAsr — client for the VibeVoice-ASR diarization server
 * (scripts/vibevoice-asr-server.py), which keeps microsoft/VibeVoice-ASR
 * loaded and returns "who said what and when" for an audio chunk.
 *
 * Unlike the chunk-based whisper STT, VibeVoice-ASR jointly performs ASR,
 * speaker diarization and timestamping, so the meeting transcript carries a
 * real speaker label per line instead of a generic "meeting".
 */
export interface DiarizedSegment {
  /** Speaker label (e.g. "SPEAKER_00", or a name when context hints are given). */
  speaker: string;
  text: string;
  /** Start offset within the chunk, in milliseconds. */
  startMs: number;
  /** End offset within the chunk, in milliseconds. */
  endMs: number;
}

export interface VibeVoiceAsrOptions {
  /** Server base URL (default http://127.0.0.1:17500). */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

export class VibeVoiceAsr {
  private baseUrl: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options: VibeVoiceAsrOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:17500').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  async isRunning(): Promise<boolean> {
    const health = await this.health();
    return health?.ok === true;
  }

  /**
   * Fetch the server's health report. Returns null when the server is
   * unreachable; otherwise { ok, state: 'loading'|'ready'|'error', model,
   * device, error }. The server answers while the model is still
   * downloading/loading, so `state` distinguishes those phases.
   */
  async health(): Promise<{ ok: boolean; state: string; model?: string; device?: string; error?: string | null } | null> {
    try {
      const res = await this.request(`${this.baseUrl}/health`, {}, 3000);
      if (!res.ok) return null;
      return (await res.json()) as { ok: boolean; state: string; model?: string; device?: string; error?: string | null };
    } catch {
      return null;
    }
  }

  /**
   * Transcribe an audio buffer into diarized segments. `context` is passed to
   * the model as hotwords/context (e.g. "Speakers: Alice, Bob" or jargon).
   */
  async transcribe(audio: Buffer, opts: { context?: string; language?: string } = {}): Promise<DiarizedSegment[]> {
    if (!audio || audio.length === 0) return [];

    const form = new FormData();
    form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
    if (opts.context) form.append('context', opts.context);
    if (opts.language) form.append('language', opts.language);

    const res = await this.request(`${this.baseUrl}/transcribe`, { method: 'POST', body: form }, this.timeoutMs);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ASR /transcribe failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as { segments?: unknown; error?: string };
    if (body.error) throw new Error(`VibeVoice ASR error: ${body.error}`);
    return parseDiarizedSegments(body.segments);
  }

  /** Fetch with a timeout whose timer is always cleared (no leak in tests). */
  private async request(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse the server's segment objects into DiarizedSegment[]. */
export function parseDiarizedSegments(raw: unknown): DiarizedSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: DiarizedSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const speaker = first(rec, ['speaker_id', 'speaker', 'Speaker ID', 'Speaker']);
    const text = first(rec, ['text', 'content', 'Content']);
    if (!text) continue;
    const startSec = firstNumber(rec, ['start_time', 'start', 'Start time', 'Start']);
    const endSec = firstNumber(rec, ['end_time', 'end', 'End time', 'End']);
    out.push({
      speaker: speaker || 'SPEAKER',
      text,
      startMs: Math.max(0, Math.round(startSec * 1000)),
      endMs: Math.max(0, Math.round(endSec * 1000)),
    });
  }
  return out;
}

function first(rec: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function firstNumber(rec: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const n = toNumber(rec[k]);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}
