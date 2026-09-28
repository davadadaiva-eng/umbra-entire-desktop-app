import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';
import { WindowsTts } from '../audio/WindowsTts';
import { VOICE_FIX, isConnectionError, unreachable } from './VoiceFallbacks';

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
  state: 'ready' | 'loading' | 'degraded' | 'error';
  voice: string;
  device: string;
  error?: string;
  /** What Umbra speaks with instead while the Piper server is down. */
  fallback?: string;
  /** Command that restores Piper. */
  fix?: string;
}

export interface PiperSpeakResult {
  wav: Buffer;
  /** Which engine actually produced the audio. */
  provider: 'piper' | 'windows-sapi';
  /** True when Piper was down and SAPI covered for it. */
  degraded: boolean;
  error?: string;
  fix?: string;
}

export interface PiperTtsOptions {
  baseUrl?: string;
  defaultVoice?: string;
  defaultLanguage?: string;
  timeoutMs?: number;
  outputDir?: string;
  /**
   * Windows SAPI engine used when the Piper server is not listening. Built
   * lazily from `outputDir` when not supplied — SAPI ships with Windows, so
   * this keeps speech working on a machine that never ran `piper:tts-server`.
   */
  windowsTts?: WindowsTts;
  /** Set false to fail instead of falling back to SAPI. */
  fallbackToWindows?: boolean;
}

/**
 * PiperTts — client for the Piper TTS microservice, with a Windows SAPI
 * fallback so `speak()` never fails just because the server was never started.
 *
 * Uses Piper TTS CLI for fast, local, CPU-optimized text-to-speech.
 * Default voice: it_IT-riccardo-medium (Italian male).
 * Supports any Piper voice model installed in ~/.piper/models/.
 *
 * Server: scripts/piper-tts-server.py (port 17520)
 * Model download: npm run piper:model-download
 * Start server:   npm run piper:tts-server
 */
export class PiperTts {
  private baseUrl: string;
  private defaultVoice: string;
  private defaultLanguage: string;
  private timeoutMs: number;
  private outputDir: string;
  private windowsTts: WindowsTts | undefined;
  private fallbackToWindows: boolean;

  constructor(opts: PiperTtsOptions = {}) {
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:17520').replace(/\/$/, '');
    this.defaultVoice = opts.defaultVoice || 'it_IT-riccardo-medium';
    this.defaultLanguage = opts.defaultLanguage || 'it';
    this.timeoutMs = opts.timeoutMs || 30_000;
    this.outputDir = opts.outputDir || path.join(process.env.HOME || process.env.USERPROFILE || '', '.umbra', 'tts');
    this.windowsTts = opts.windowsTts;
    this.fallbackToWindows = opts.fallbackToWindows !== false;
  }

  get available(): boolean {
    return Boolean(this.baseUrl);
  }

  /** Lazily build the SAPI engine; WindowsTts keeps `outputDir/../tmp` for scratch WAVs. */
  private sapi(): WindowsTts | undefined {
    if (!this.fallbackToWindows) return undefined;
    if (!this.windowsTts) {
      this.windowsTts = new WindowsTts(path.dirname(this.outputDir));
    }
    return this.windowsTts.available ? this.windowsTts : undefined;
  }

  /** The command that brings Piper back. */
  get fixCommand(): string {
    return VOICE_FIX.ttsPiper;
  }

  /**
   * Probe the Piper server. Never throws: a server that is not listening is a
   * degraded health report, not an exception, so boot can continue.
   */
  async health(): Promise<PiperHealth> {
    const { HttpBridge } = await import('../agent/HttpBridge.js');
    try {
      const res = await HttpBridge.request({ url: `${this.baseUrl}/health`, method: 'GET', timeoutMs: 5000 });
      if (res.status < 200 || res.status >= 300) throw new Error(`Health check failed: ${res.status}`);
      return { ...(res.data as PiperHealth), ok: true, state: 'ready' };
    } catch (err) {
      const failure = unreachable('Piper TTS', this.baseUrl, err, 'Windows SAPI (built into Windows)', this.fixCommand);
      return {
        ok: false,
        state: isConnectionError(err) ? 'degraded' : 'error',
        voice: this.defaultVoice,
        device: 'cpu',
        error: failure.error,
        fallback: failure.fallback,
        fix: failure.fix,
      };
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const h = await this.health();
      return h.state === 'ready';
    } catch {
      return false;
    }
  }

  /** True when speech can still be produced even if Piper is down. */
  get degradedAvailable(): boolean {
    return Boolean(this.sapi());
  }

  async listVoices(): Promise<PiperVoice[]> {
    const res = await fetch(`${this.baseUrl}/voices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Failed to list voices: ${res.status}`);
    return res.json() as Promise<PiperVoice[]>;
  }

  /**
   * Synthesize speech and return WAV bytes.
   *
   * Falls back to Windows SAPI when the Piper server is not listening, so a
   * cold machine still speaks instead of failing the whole request.
   */
  async speak(text: string, opts: { voice?: string; language?: string } = {}): Promise<Buffer> {
    const result = await this.speakWithFallback(text, opts);
    return result.wav;
  }

  /**
   * Synthesize speech, reporting which engine answered. This is the variant
   * callers that surface provider state to the UI should use.
   */
  async speakWithFallback(
    text: string,
    opts: { voice?: string; language?: string } = {},
  ): Promise<PiperSpeakResult> {
    const voice = opts.voice || this.defaultVoice;

    getLogger().info({ baseUrl: this.baseUrl, voice, text: text.slice(0, 80) }, 'Synthesizing via Piper TTS');

    try {
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

      const wav = Buffer.from(await res.arrayBuffer());
      getLogger().info({ bytes: wav.length, voice }, 'Piper TTS synthesis complete');
      return { wav, provider: 'piper', degraded: false };
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      const sapi = this.sapi();
      if (!sapi) throw err;
      const failure = unreachable('Piper TTS', this.baseUrl, err, 'Windows SAPI (built into Windows)', this.fixCommand);
      getLogger().warn({ baseUrl: this.baseUrl, fix: failure.fix }, 'Piper TTS not running — speaking with Windows SAPI');
      const wav = await sapi.synthesize(text);
      return {
        wav,
        provider: 'windows-sapi',
        degraded: true,
        error: failure.error,
        fix: failure.fix,
      };
    }
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

    try {
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
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      const sapi = this.sapi();
      if (!sapi) throw err;
      getLogger().warn({ baseUrl: this.baseUrl }, 'Piper TTS not running — writing file with Windows SAPI');
      // SAPI has no "write to this path" endpoint, so render then persist.
      const wav = await sapi.synthesize(text);
      fs.writeFileSync(outputPath, wav);
      return outputPath;
    }
  }
}
