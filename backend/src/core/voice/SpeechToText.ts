import { UmbraConfig } from '../../types';
import { getLogger } from '../Logger';
import { FasterWhisperStt } from './FasterWhisperStt';

export interface TranscriptionRequest {
  /** Raw audio bytes (wav/mp3/ogg/webm/flac). */
  audio: Buffer;
  /** MIME type / format hint (defaults to 'audio/webm'). */
  format?: 'wav' | 'mp3' | 'ogg' | 'webm' | 'flac' | 'm4a';
  /** ISO language code, e.g. 'en' (optional — Whisper auto-detects). */
  language?: string;
  /** Optional hint text (names, jargon) to bias the transcript. */
  prompt?: string;
}

export interface TranscriptionResult {
  text: string;
  model: string;
  provider: string;
  language?: string;
}

const MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
};

const EXT: Record<string, string> = {
  wav: 'wav', mp3: 'mp3', ogg: 'ogg', webm: 'webm', flac: 'flac', m4a: 'm4a',
};

/**
 * SpeechToText — voice-to-text with pluggable backends.
 *
 *  - `openai`           → OpenAI Whisper API (one key, very good accuracy).
 *  - `whisper-local`    → a self-hosted whisper.cpp server (free, offline).
 *  - `voicebox`         → Voicebox's bundled Whisper via /transcribe (local, no key).
 *  - `faster-whisper`   → faster-whisper STT server (free, offline, CPU, Italian default).
 *  - `none`             → disabled; callers use the browser's on-device STT
 *                      (the PWA already does this via SpeechRecognition).
 */
export class SpeechToText {
  private config: UmbraConfig['voice'];
  private openaiApiKey: string;
  private fasterWhisper: FasterWhisperStt;

  constructor(config: UmbraConfig) {
    this.config = config.voice;
    this.openaiApiKey = config.voice.sttApiKey || config.openai?.apiKey || '';
    this.fasterWhisper = new FasterWhisperStt({
      baseUrl: config.voice.fasterWhisperUrl,
      defaultLanguage: config.voice.fasterWhisperLanguage,
    });
  }

  get provider(): string {
    return this.config.sttProvider;
  }

  get available(): boolean {
    if (!this.config.enabled) return false;
    if (this.config.sttProvider === 'none') return false;
    if (this.config.sttProvider === 'openai') return Boolean(this.openaiApiKey);
    if (this.config.sttProvider === 'voicebox') return Boolean(this.config.voiceboxUrl);
    if (this.config.sttProvider === 'faster-whisper') return Boolean(this.config.fasterWhisperUrl);
    return Boolean(this.config.sttEndpoint);
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.config.enabled || this.config.sttProvider === 'none') {
      throw new Error('Voice transcription is not enabled — set voice.enabled + voice.sttProvider');
    }

    const format = req.format ?? 'webm';
    const mime = MIME[format] ?? 'audio/webm';
    const ext = EXT[format] ?? 'webm';

    if (this.config.sttProvider === 'openai') {
      return this.transcribeOpenAi(req, mime, ext);
    }
    if (this.config.sttProvider === 'whisper-local') {
      return this.transcribeLocal(req, mime, ext);
    }
    if ((this.config.sttProvider as string) === 'voicebox') {
      return this.transcribeVoicebox(req);
    }
    if (this.config.sttProvider === 'faster-whisper') {
      return this.transcribeFasterWhisper(req);
    }
    throw new Error(`Unknown STT provider: ${this.config.sttProvider}`);
  }

  private async transcribeOpenAi(req: TranscriptionRequest, mime: string, ext: string): Promise<TranscriptionResult> {
    if (!this.openaiApiKey) throw new Error('OpenAI STT needs an API key (voice.sttApiKey or openai.apiKey)');

    const form = new FormData();
    form.append('file', new Blob([req.audio], { type: mime }), `audio.${ext}`);
    form.append('model', this.config.sttModel || 'whisper-1');
    form.append('response_format', 'json');
    if (req.language) form.append('language', req.language);
    if (req.prompt) form.append('prompt', req.prompt);

    const endpoint = this.config.sttEndpoint || 'https://api.openai.com/v1/audio/transcriptions';
    getLogger().info({ endpoint, model: this.config.sttModel, bytes: req.audio.length }, 'Transcribing via OpenAI Whisper');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openaiApiKey}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Whisper transcription failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as { text?: string; language?: string };
    return { text: (data.text || '').trim(), model: this.config.sttModel || 'whisper-1', provider: 'openai', language: data.language };
  }

  private async transcribeLocal(req: TranscriptionRequest, mime: string, ext: string): Promise<TranscriptionResult> {
    const base = (this.config.sttEndpoint || 'http://localhost:8080').replace(/\/$/, '');
    // whisper.cpp server: multipart POST to /inference with the 'file' field.
    const form = new FormData();
    form.append('file', new Blob([req.audio], { type: mime }), `audio.${ext}`);
    // Greedy decoding (temperature 0) is what keeps whisper.cpp from
    // hallucinating/missing words — it always takes the most likely tokens.
    form.append('temperature', '0.0');
    form.append('response_format', 'json');
    if (req.language) form.append('language', req.language);
    if (req.prompt) form.append('prompt', req.prompt);

    getLogger().info({ endpoint: `${base}/inference`, bytes: req.audio.length }, 'Transcribing via local whisper.cpp');

    const res = await fetch(`${base}/inference`, { method: 'POST', body: form });
    if (!res.ok) {
      throw new Error(`whisper.cpp transcription failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as { text?: string };
    return { text: (data.text || '').trim(), model: this.config.sttModel || 'whisper.cpp', provider: 'whisper-local' };
  }

  private async transcribeVoicebox(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const base = (this.config.voiceboxUrl || 'http://127.0.0.1:17493').replace(/\/$/, '');
    const form = new FormData();
    const ext = req.format || 'wav';
    form.append('audio', new Blob([req.audio], { type: `audio/${ext}` }), `audio.${ext}`);
    if (req.language) form.append('language', req.language);
    getLogger().info({ endpoint: `${base}/transcribe`, bytes: req.audio.length }, 'Transcribing via Voicebox');
    const res = await fetch(`${base}/transcribe`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Voicebox transcription failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { text?: string; transcript?: string };
    return { text: ((data.text || data.transcript) || '').trim(), model: 'voicebox-whisper', provider: 'voicebox' };
  }

  private async transcribeFasterWhisper(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const result = await this.fasterWhisper.transcribe(req.audio, {
      language: req.language,
      format: req.format,
    });
    return { text: result.text, model: result.model, provider: 'faster-whisper', language: result.language };
  }
}
