import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

export interface PiperVoice {
  id: string;
  language: string;
  name: string;
  gender: string;
  file: string;
  has_config: boolean;
}

export interface PiperHealth {
  ok: boolean;
  state: 'ready' | 'error';
  voice: string;
  device: string;
  error?: string;
}

export interface PiperTtsOptions {
  baseUrl?: string;
  defaultVoice?: string;
  defaultLanguage?: string;
  timeoutMs?: number;
  outputDir?: string;
}

/**
 * PiperTts — client for the Piper TTS microservice.
 *
 * Uses Piper TTS CLI for fast, local, CPU-optimized text-to-speech.
 * Default voice: it_IT-riccardo-medium (Italian male).
 * Supports any Piper voice model installed in ~/.piper/models/.
 *
 * Server: scripts/piper-tts-server.py (port 17520)
 * Model download: npm run piper:model-download
 */
export class PiperTts {
  private baseUrl: string;
  private defaultVoice: string;
  private defaultLanguage: string;
  private timeoutMs: number;
  private outputDir: string;

  constructor(opts: PiperTtsOptions = {}) {
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:17520').replace(/\/$/, '');
    this.defaultVoice = opts.defaultVoice || 'it_IT-riccardo-medium';
    this.defaultLanguage = opts.defaultLanguage || 'it';
    this.timeoutMs = opts.timeoutMs || 30_000;
    this.outputDir = opts.outputDir || path.join(process.env.HOME || process.env.USERPROFILE || '', '.umbra', 'tts');
  }

  get available(): boolean {
    return Boolean(this.baseUrl);
  }

  async health(): Promise<PiperHealth> {
    const { HttpBridge } = await import('../agent/HttpBridge.js');
    const res = await HttpBridge.request({ url: `${this.baseUrl}/health`, method: 'GET', timeoutMs: 5000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`Health check failed: ${res.status}`);
    return res.data as PiperHealth;
  }

  async isRunning(): Promise<boolean> {
    try {
      const h = await this.health();
      return h.state === 'ready';
    } catch {
      return false;
    }
  }

  async listVoices(): Promise<PiperVoice[]> {
    const res = await fetch(`${this.baseUrl}/voices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Failed to list voices: ${res.status}`);
    return res.json() as Promise<PiperVoice[]>;
  }

  /**
   * Synthesize speech and return WAV bytes.
   */
  async speak(text: string, opts: { voice?: string; language?: string } = {}): Promise<Buffer> {
    const voice = opts.voice || this.defaultVoice;

    getLogger().info({ baseUrl: this.baseUrl, voice, text: text.slice(0, 80) }, 'Synthesizing via Piper TTS');

    const res = await fetch(`${this.baseUrl}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Piper TTS failed: ${res.status} ${body}`);
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    getLogger().info({ bytes: buffer.length, voice }, 'Piper TTS synthesis complete');
    return buffer;
  }

  /**
   * Synthesize speech and save to a WAV file.
   * Returns the absolute path of the created file.
   */
  async speakToFile(text: string, opts: { voice?: string; language?: string; outputPath?: string } = {}): Promise<string> {
    const voice = opts.voice || this.defaultVoice;
    const outputPath = opts.outputPath || path.join(
      this.outputDir,
      `piper-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`,
    );

    // Ensure output directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    getLogger().info({ baseUrl: this.baseUrl, voice, outputPath }, 'Synthesizing to file via Piper TTS');

    const res = await fetch(`${this.baseUrl}/speak/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, output_path: outputPath }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Piper TTS file synthesis failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { ok: boolean; path: string; voice: string };
    if (!data.ok || !fs.existsSync(data.path)) {
      throw new Error('Piper TTS produced no output file');
    }

    getLogger().info({ path: data.path, voice: data.voice }, 'Piper TTS file synthesis complete');
    return data.path;
  }
}
