import { getLogger } from '../Logger';

export interface FasterWhisperHealth {
  ok: boolean;
  state: 'loading' | 'ready' | 'error';
  model: string;
  device: string;
  language: string;
  error?: string;
}

export interface FasterWhisperTranscription {
  text: string;
  language: string;
  model: string;
  duration_ms: number;
}

export interface FasterWhisperSttOptions {
  baseUrl?: string;
  defaultLanguage?: string;
  timeoutMs?: number;
}

/**
 * FasterWhisperStt — client for the faster-whisper STT microservice.
 *
 * Uses faster-whisper (base model, int8) for CPU-optimized speech-to-text.
 * Default language: Italian (it). Fully offline after model download.
 *
 * Server: scripts/faster-whisper-stt-server.py (port 17510)
 */
export class FasterWhisperStt {
  private baseUrl: string;
  private defaultLanguage: string;
  private timeoutMs: number;

  constructor(opts: FasterWhisperSttOptions = {}) {
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:17510').replace(/\/$/, '');
    this.defaultLanguage = opts.defaultLanguage || 'it';
    this.timeoutMs = opts.timeoutMs || 30_000;
  }

  get available(): boolean {
    return Boolean(this.baseUrl);
  }

  async health(): Promise<FasterWhisperHealth> {
    const { HttpBridge } = await import('../agent/HttpBridge.js');
    const res = await HttpBridge.request({ url: `${this.baseUrl}/health`, method: 'GET', timeoutMs: 5000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`Health check failed: ${res.status}`);
    return res.data as FasterWhisperHealth;
  }

  async isRunning(): Promise<boolean> {
    try {
      const h = await this.health();
      return h.state === 'ready';
    } catch {
      return false;
    }
  }

  async transcribe(audioBuffer: Buffer, opts: { language?: string; format?: string } = {}): Promise<FasterWhisperTranscription> {
    const lang = opts.language || this.defaultLanguage;
    const ext = opts.format || 'wav';

    const form = new FormData();
    form.append('audio', new Blob([audioBuffer], { type: `audio/${ext}` }), `audio.${ext}`);
    form.append('language', lang);

    getLogger().info({ baseUrl: this.baseUrl, language: lang, bytes: audioBuffer.length }, 'Transcribing via faster-whisper');

    const res = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Faster-whisper transcription failed: ${res.status} ${body}`);
    }

    const data = await res.json() as FasterWhisperTranscription;
    getLogger().info({ text: data.text?.slice(0, 100), duration_ms: data.duration_ms }, 'Faster-whisper transcription complete');
    return data;
  }
}
