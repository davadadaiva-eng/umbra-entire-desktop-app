/**
 * VoiceboxClient — HTTP client for the open-source Voicebox voice studio
 * (https://github.com/jamiepine/voicebox), a local-first AI voice app with
 * voice cloning, 23 languages and 7 TTS engines. It runs its own FastAPI
 * server at http://127.0.0.1:17493 (see the app's /docs).
 *
 * Endpoints used:
 *  - GET  /health                         → is it running
 *  - GET  /profiles                       → cloned/preset voice profiles
 *  - POST /speak {text, profile, ...}     → speak out loud (plays locally)
 *  - GET  /generate/{id}/status           → SSE status stream until done
 *  - POST /generate/stream                → raw WAV bytes (no playback)
 *  - POST /transcribe                     → Whisper STT (multipart)
 *
 * `speak()` plays audio through Voicebox's own playback (so it surfaces on
 * the user's speakers); `synthesize()` returns WAV bytes for Umbra to route
 * elsewhere (e.g. into a meeting via a virtual cable).
 */
import { getLogger } from '../Logger';

export interface VoiceboxProfile {
  id: string;
  name: string;
  language?: string;
  voiceType?: string;
  engine?: string;
  sampleCount?: number;
}

export interface VoiceboxSpeakOptions {
  /** Voice profile name or id. */
  profile?: string;
  language?: string;
  engine?: string;
  personality?: boolean;
}

export interface VoiceboxClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

export class VoiceboxClient {
  private baseUrl: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private generationTimeoutMs = 5 * 60 * 1000;

  constructor(options: VoiceboxClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:17493').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  async isRunning(): Promise<boolean> {
    try {
      const res = await this.request(`${this.baseUrl}/health`, {}, 3000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listProfiles(): Promise<VoiceboxProfile[]> {
    const res = await this.request(`${this.baseUrl}/profiles`, {}, this.timeoutMs);
    if (!res.ok) {
      getLogger().warn({ status: res.status }, 'Voicebox /profiles failed');
      return [];
    }
    const body = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(body)) return [];
    return body
      .map(p => ({
        id: String(p['id'] ?? ''),
        name: String(p['name'] ?? ''),
        language: p['language'] ? String(p['language']) : undefined,
        voiceType: p['voice_type'] ? String(p['voice_type']) : undefined,
        engine: p['default_engine'] ? String(p['default_engine']) : undefined,
        sampleCount: typeof p['sample_count'] === 'number' ? (p['sample_count'] as number) : undefined,
      }))
      .filter(p => p.id || p.name);
  }

  /** Resolve a profile name (or id) to its id; returns the input if already an id. */
  async resolveProfile(nameOrId: string): Promise<string | null> {
    if (!nameOrId) return null;
    const profiles = await this.listProfiles();
    const exact = profiles.find(p => p.id === nameOrId || p.name.toLowerCase() === nameOrId.toLowerCase());
    if (exact) return exact.id;
    const partial = profiles.find(p => p.name.toLowerCase().includes(nameOrId.toLowerCase()));
    return partial?.id ?? null;
  }

  /**
   * Speak out loud through Voicebox (it plays the audio locally). POSTs to
   * /speak then follows the /generate/{id}/status SSE stream until the
   * generation completes or fails.
   */
  async speak(text: string, opts: VoiceboxSpeakOptions = {}): Promise<{ status: string; id: string }> {
    const t = text.trim();
    if (!t) throw new Error('Voicebox: empty text');

    const res = await this.request(`${this.baseUrl}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Voicebox-Client-Id': 'umbra-os' },
      body: JSON.stringify({
        text: t,
        profile: opts.profile,
        language: opts.language,
        engine: opts.engine,
        personality: opts.personality,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Voicebox /speak failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const gen = (await res.json()) as { id?: string; status?: string };
    if (!gen.id) throw new Error('Voicebox /speak returned no generation id');

    getLogger().info({ id: gen.id }, 'Voicebox speaking');
    const status = await this.waitForStatus(gen.id);
    return { status, id: gen.id };
  }

  /** Generate speech and return the WAV bytes (does not play). */
  async synthesize(text: string, opts: VoiceboxSpeakOptions = {}): Promise<Buffer> {
    const t = text.trim();
    if (!t) throw new Error('Voicebox: empty text');

    let profileId = await this.resolveProfile(opts.profile ?? '');
    if (!profileId) {
      const profiles = await this.listProfiles();
      if (profiles.length === 0) throw new Error(`Voicebox: no profiles available — clone a voice first`);
      profileId = profiles[0].id || profiles[0].name;
      if (!profileId) throw new Error(`Voicebox: no profile found for "${opts.profile}"`);
    }

    const res = await this.request(`${this.baseUrl}/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profileId,
        text: t,
        language: opts.language,
        engine: opts.engine,
      }),
    }, this.generationTimeoutMs);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Voicebox /generate/stream failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Transcribe audio bytes to text via Voicebox's bundled Whisper. */
  async transcribe(audio: Buffer, opts: { format?: string; model?: string; language?: string } = {}): Promise<string> {
    const form = new FormData();
    form.append('audio', new Blob([audio], { type: `audio/${opts.format ?? 'wav'}` }), `audio.${opts.format ?? 'wav'}`);
    if (opts.model) form.append('model', opts.model);
    if (opts.language) form.append('language', opts.language);

    const res = await this.request(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
    }, this.generationTimeoutMs);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Voicebox /transcribe failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as { text?: string; transcript?: string };
    return (body.text || body.transcript || '').trim();
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

  /** Follow the SSE status stream until a terminal state; returns the status. */
  private async waitForStatus(id: string): Promise<string> {
    const res = await this.request(`${this.baseUrl}/generate/${id}/status`, {
      headers: { Accept: 'text/event-stream' },
    }, this.generationTimeoutMs);
    if (!res.ok) {
      throw new Error(`Voicebox status fetch failed (${res.status})`);
    }
    const text = await res.text();

    let status = 'completed';
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      let event: { status?: string; error?: string } | null = null;
      try { event = JSON.parse(payload); } catch { continue; }
      if (!event) continue;
      if (event.status) status = event.status;
      if (event.status === 'failed') {
        throw new Error(`Voicebox generation ${id} failed: ${event.error || 'unknown error'}`);
      }
      if (event.status === 'not_found') {
        throw new Error(`Voicebox generation ${id} not found`);
      }
    }
    return status;
  }
}
