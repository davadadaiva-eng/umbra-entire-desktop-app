import { getLogger } from '../Logger';

/**
 * Minimal client for the Voicebox local voice studio (http://127.0.0.1:17493).
 * POST /speak schedules speech in a cloned voice profile and returns a
 * generation id; we poll GET /generate/{id}/status until the audio file
 * exists, then return its absolute path.
 */
export interface SpeakOptions {
  profile?: string;
  engine?: string;
  personality?: boolean;
  language?: string;
}

export class VoiceboxTTS {
  private baseUrl: string;
  private pollIntervalMs = 2000;
  private pollTimeoutMs = 5 * 60 * 1000;

  constructor(baseUrl = 'http://127.0.0.1:17493') {
    this.baseUrl = baseUrl;
  }

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listProfiles(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/profiles`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const body = (await res.json()) as { profiles?: Array<{ name?: string }> };
      return (body.profiles || []).map(p => p.name || '').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Speak text in a voice profile; resolves to the absolute local audio file path. */
  async speak(text: string, opts: SpeakOptions = {}): Promise<string> {
    if (!text.trim()) throw new Error('Voicebox: empty text');

    const res = await fetch(`${this.baseUrl}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        profile: opts.profile,
        engine: opts.engine,
        personality: opts.personality,
        language: opts.language || 'en',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Voicebox /speak failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const body = (await res.json()) as { id?: string; status?: string; audio_path?: string; poll_url?: string };
    if (body.audio_path && body.status === 'completed') return body.audio_path;

    const id = body.id;
    if (!id) {
      throw new Error('Voicebox /speak returned no generation id');
    }

    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs));
      const status = await this.pollStatus(id);
      if (status.audio_path) return status.audio_path;
      if (status.status === 'failed' || status.status === 'error') {
        throw new Error(`Voicebox generation ${id} failed: ${status.error || 'unknown error'}`);
      }
    }

    throw new Error(`Voicebox generation ${id} timed out after ${this.pollTimeoutMs / 1000}s`);
  }

  private async pollStatus(id: string): Promise<{ status?: string; audio_path?: string; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/generate/${id}/status`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return {};
      return (await res.json()) as { status?: string; audio_path?: string; error?: string };
    } catch (err: any) {
      getLogger().debug({ err: err.message, id }, 'Voicebox status poll failed');
      return {};
    }
  }
}
