import { SpeechToText } from './SpeechToText';
import { UmbraConfig } from '../../types';

function makeConfig(voice: Partial<UmbraConfig['voice']>, openaiKey?: string): UmbraConfig {
  return {
    voice: {
      enabled: false,
      sttProvider: 'none',
      sttEndpoint: '',
      sttApiKey: '',
      sttModel: 'whisper-1',
      ...voice,
    },
    openai: openaiKey ? { apiKey: openaiKey } : undefined,
  } as unknown as UmbraConfig;
}

function jsonResponse(obj: unknown) {
  return { ok: true, json: async () => obj, text: async () => '' } as unknown as Response;
}

describe('SpeechToText', () => {
  const audio = Buffer.from('fake-audio-bytes');

  afterEach(() => {
    (global as any).fetch.mockRestore?.();
  });

  it('reports unavailable and throws when disabled', async () => {
    const stt = new SpeechToText(makeConfig({}));
    expect(stt.available).toBe(false);
    await expect(stt.transcribe({ audio })).rejects.toThrow(/not enabled/);
  });

  it('transcribes via the OpenAI Whisper backend', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ text: ' hello world ', language: 'en' }));
    (global as any).fetch = fetchMock;

    const stt = new SpeechToText(makeConfig({ enabled: true, sttProvider: 'openai', sttModel: 'whisper-1' }, 'sk-test'));
    expect(stt.available).toBe(true);

    const result = await stt.transcribe({ audio, format: 'webm', language: 'en' });

    expect(result.text).toBe('hello world');
    expect(result.provider).toBe('openai');
    expect(result.language).toBe('en');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/audio/transcriptions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('uses the OpenAI api key from voice.sttApiKey when openai.apiKey is absent', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ text: 'hi' }));
    (global as any).fetch = fetchMock;

    const stt = new SpeechToText(makeConfig({ enabled: true, sttProvider: 'openai', sttApiKey: 'sk-voice' }));
    expect(stt.available).toBe(true);
    await stt.transcribe({ audio });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-voice');
  });

  it('transcribes via a local whisper.cpp server', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ text: 'local transcript' }));
    (global as any).fetch = fetchMock;

    const stt = new SpeechToText(makeConfig({
      enabled: true,
      sttProvider: 'whisper-local',
      sttEndpoint: 'http://localhost:8080',
      sttModel: 'base.en',
    }));

    const result = await stt.transcribe({ audio, format: 'wav' });
    expect(result.text).toBe('local transcript');
    expect(result.provider).toBe('whisper-local');
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/inference');
  });

  it('degrades instead of throwing when the STT server is not running', async () => {
    // Node/undici shape for ECONNREFUSED: TypeError('fetch failed') with the
    // real netcode one level down in `cause`.
    const refused = new TypeError('fetch failed');
    (refused as any).cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:17510'), { code: 'ECONNREFUSED' });
    (global as any).fetch = jest.fn().mockRejectedValue(refused);

    const stt = new SpeechToText(makeConfig({
      enabled: true,
      sttProvider: 'faster-whisper',
      fasterWhisperUrl: 'http://127.0.0.1:17510',
    }));

    const result = await stt.transcribe({ audio, format: 'wav' });

    // Degraded, not an exception: the caller can fall back to Web Speech API.
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.provider).toBe('faster-whisper');
    expect(result.error).toMatch(/not running at http:\/\/127\.0\.0\.1:17510/);
    expect(result.hint).toBe('cd backend && npm run whisper:stt-server');
    expect(result.fallback).toMatch(/Web Speech API/);
  });

  it('still throws for a real request failure (not a dead server)', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid api key',
    } as unknown as Response);

    const stt = new SpeechToText(makeConfig({ enabled: true, sttProvider: 'openai' }, 'sk-bad'));
    // A 401 is a config bug — a fallback would just hide it.
    await expect(stt.transcribe({ audio })).rejects.toThrow(/401/);
  });
});
