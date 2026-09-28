import { PiperTts } from './PiperTts';
import { WindowsTts } from '../audio/WindowsTts';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A WindowsTts stand-in that returns a known WAV without touching SAPI. */
function fakeSapi(wav: Buffer) {
  const synth = jest.fn().mockResolvedValue(wav);
  return { instance: { available: true, speak: jest.fn(), synthesize: synth } as unknown as WindowsTts, synth };
}

function refused(): Promise<never> {
  const err = new TypeError('fetch failed');
  (err as any).cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:17520'), { code: 'ECONNREFUSED' });
  return Promise.reject(err);
}

describe('PiperTts offline fallback', () => {
  const wav = Buffer.from('RIFF-fake-wav');

  afterEach(() => {
    (global as any).fetch.mockRestore?.();
  });

  it('uses Piper when the server is up', async () => {
    // Copy out of the Buffer pool — `Buffer.from(arrayBuffer)` would otherwise
    // hand back the whole pooled ArrayBuffer, not just our bytes.
    const exact = Uint8Array.from(wav);
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => exact.buffer,
    } as unknown as Response);
    const { instance, synth } = fakeSapi(wav);
    const tts = new PiperTts({ baseUrl: 'http://127.0.0.1:17520', windowsTts: instance });

    const result = await tts.speakWithFallback('ciao');

    expect(result.provider).toBe('piper');
    expect(result.degraded).toBe(false);
    expect(result.wav).toEqual(wav);
    expect(synth).not.toHaveBeenCalled();
  });

  it('falls back to Windows SAPI when Piper is not running, and reports the fix', async () => {
    (global as any).fetch = jest.fn().mockImplementation(() => refused());
    const { instance, synth } = fakeSapi(wav);
    const tts = new PiperTts({ baseUrl: 'http://127.0.0.1:17520', windowsTts: instance });

    const result = await tts.speakWithFallback('ciao');

    expect(result.provider).toBe('windows-sapi');
    expect(result.degraded).toBe(true);
    expect(result.wav).toEqual(wav);
    expect(result.fix).toBe('cd backend && npm run piper:tts-server');
    expect(result.error).toMatch(/not running at http:\/\/127\.0\.0\.1:17520/);
    expect(synth).toHaveBeenCalledWith('ciao');
  });

  it('speak() still returns a WAV buffer on the fallback path', async () => {
    (global as any).fetch = jest.fn().mockImplementation(() => refused());
    const { instance } = fakeSapi(wav);
    const tts = new PiperTts({ baseUrl: 'http://127.0.0.1:17520', windowsTts: instance });

    await expect(tts.speak('ciao')).resolves.toEqual(wav);
  });

  it('rethrows when the server answers with a real error', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'model missing',
    } as unknown as Response);
    const { instance } = fakeSapi(wav);
    const tts = new PiperTts({ baseUrl: 'http://127.0.0.1:17520', windowsTts: instance });

    await expect(tts.speak('ciao')).rejects.toThrow(/500 model missing/);
  });

  it('rethrows a dead-server error when the SAPI fallback is disabled', async () => {
    (global as any).fetch = jest.fn().mockImplementation(() => refused());
    const tts = new PiperTts({ baseUrl: 'http://127.0.0.1:17520', fallbackToWindows: false });

    await expect(tts.speak('ciao')).rejects.toThrow(/fetch failed/);
  });

  // NOTE: health() is not unit-tested — it dynamic-imports HttpBridge with an
  // ESM '.js' specifier, which ts-jest cannot resolve. Same pre-existing
  // limitation as FasterWhisperStt.health(). Its degraded contract is covered
  // through VoiceStackHealth's probes instead.

  it('speakToFile writes the SAPI output to the requested path when Piper is down', async () => {
    (global as any).fetch = jest.fn().mockImplementation(() => refused());
    const { instance } = fakeSapi(wav);
    const out = path.join(os.tmpdir(), `piper-fallback-${Date.now()}.wav`);
    const tts = new PiperTts({ baseUrl: 'http://127.0.0.1:17520', windowsTts: instance });

    const written = await tts.speakToFile('ciao', { outputPath: out });

    try {
      expect(written).toBe(out);
      expect(fs.readFileSync(out)).toEqual(wav);
    } finally {
      try { fs.unlinkSync(out); } catch { /* best effort */ }
    }
  });
});
