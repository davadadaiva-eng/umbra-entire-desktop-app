import { VoiceStackHealth, VoiceStackHealthConfig, VoiceStackProbes } from './VoiceStackHealth';

function make(
  config: Partial<VoiceStackHealthConfig> = {},
  probes: VoiceStackProbes = {},
): VoiceStackHealth {
  const full: VoiceStackHealthConfig = {
    sttProvider: 'none',
    tts: 'none',
    asrProvider: 'none',
    audioCable: 'none',
    loopbackEnabled: false,
    ...config,
  };
  return new VoiceStackHealth({ config: full, probes });
}

describe('VoiceStackHealth', () => {
  it('reports all-disabled as ok', async () => {
    const h = make();
    const report = await h.refresh();
    expect(report.ok).toBe(true);
    expect(report.components.every(c => c.status === 'disabled')).toBe(true);
  });

  it('is ok when every configured component passes', async () => {
    const h = make(
      { sttProvider: 'whisper-local', tts: 'voicebox', asrProvider: 'vibevoice', audioCable: 'auto', loopbackEnabled: true },
      {
        stt: async () => ({ ok: true, detail: 'endpoint reachable' }),
        tts: async () => ({ ok: true, detail: 'voicebox up' }),
        asr: async () => ({ ok: true, detail: 'asr server up' }),
        cable: async () => ({ ok: true, detail: 'VB-Cable found' }),
        loopback: async () => ({ ok: true, detail: 'WASAPI loopback available' }),
      },
    );
    const report = await h.refresh();
    expect(report.ok).toBe(true);
    expect(report.summary).toBe('Voice stack ready');
    expect(report.degraded).toEqual([]);
    expect(report.components.map(c => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'disabled']);
  });

  it('fails the stack when a configured component errors', async () => {
    const h = make(
      { sttProvider: 'openai', tts: 'local' },
      {
        stt: async () => ({ ok: true, detail: 'key present' }),
        tts: async () => ({ ok: false, error: 'SAPI unavailable on non-Windows' }),
      },
    );
    const report = await h.refresh();
    expect(report.ok).toBe(false);
    const tts = report.components.find(c => c.component === 'tts')!;
    expect(tts.status).toBe('error');
    expect(tts.error).toContain('SAPI');
    expect(report.summary).toContain('Voice error');
    // Disabled components still don't fail the stack.
    expect(report.components.find(c => c.component === 'asr')!.status).toBe('disabled');
  });

  it('marks a configured component degraded when no probe is wired', async () => {
    const h = make({ tts: 'vibevoice' });
    const report = await h.refresh();
    // Degraded is not a hard failure — the component runs on its fallback.
    expect(report.ok).toBe(true);
    expect(report.degraded).toEqual(['tts']);
    expect(report.components.find(c => c.component === 'tts')!.status).toBe('degraded');
  });

  it('reports a degraded component as ok, with the fix command and the fallback', async () => {
    const h = make(
      { sttProvider: 'faster-whisper', tts: 'piper' },
      {
        stt: async () => ({
          ok: true,
          status: 'degraded',
          error: 'Faster-Whisper unreachable',
          fix: 'cd backend && npm run whisper:stt-server',
          fallback: 'the desktop Web Speech API',
        }),
        tts: async () => ({
          ok: true,
          status: 'degraded',
          error: 'Piper unreachable',
          fix: 'cd backend && npm run piper:tts-server',
          fallback: 'Windows SAPI',
        }),
      },
    );
    const report = await h.refresh();

    // Servers being down must not make the stack look broken.
    expect(report.ok).toBe(true);
    expect(report.degraded).toEqual(['stt', 'tts']);
    expect(report.fixes).toEqual([
      'cd backend && npm run whisper:stt-server',
      'cd backend && npm run piper:tts-server',
    ]);
    expect(report.summary).toContain('Voice degraded');
    expect(report.summary).toContain('npm run whisper:stt-server');
    expect(report.components.every(c => c.ok)).toBe(true);
  });

  it('honors a probe status override (e.g. degraded while loading)', async () => {
    const h = make(
      { asrProvider: 'vibevoice' },
      { asr: async () => ({ ok: false, status: 'degraded', detail: 'model downloading' }) },
    );
    const report = await h.refresh();
    expect(report.ok).toBe(true);
    const asr = report.components.find(c => c.component === 'asr')!;
    expect(asr.status).toBe('degraded');
    expect(asr.detail).toContain('downloading');
  });

  it('guards against a throwing probe', async () => {
    const h = make(
      { sttProvider: 'whisper-local' },
      {
        stt: async () => {
          throw new Error('boom');
        },
      },
    );
    const report = await h.refresh();
    expect(report.ok).toBe(false);
    expect(report.components.find(c => c.component === 'stt')!.status).toBe('error');
    expect(report.components.find(c => c.component === 'stt')!.error).toBe('boom');
  });

  it('snapshot returns the cached report (deep copy)', async () => {
    const h = make({ tts: 'voicebox' }, { tts: async () => ({ ok: true }) });
    await h.refresh();
    expect(h.snapshot()).not.toBeNull();
    const snap = h.snapshot()!;
    expect(snap.ok).toBe(true);
    expect(snap.components.find(c => c.component === 'tts')!.ok).toBe(true);
  });

  it('logReport warns for degraded components and errors for failures', async () => {
    const calls: { level: string; msg: string }[] = [];
    const log = {
      warn: (_o: unknown, msg?: string) => calls.push({ level: 'warn', msg: msg || '' }),
      error: (_o: unknown, msg?: string) => calls.push({ level: 'error', msg: msg || '' }),
    };
    const h = make(
      { sttProvider: 'faster-whisper', tts: 'piper' },
      {
        stt: async () => ({ ok: true, status: 'degraded', error: 'down', fix: 'npm run whisper:stt-server' }),
        tts: async () => ({ ok: false, error: 'no SAPI on this OS' }),
      },
    );
    await h.refresh();
    h.logReport(log);
    expect(calls).toHaveLength(2);
    expect(calls[0].level).toBe('warn');
    expect(calls[0].msg).toContain('stt');
    expect(calls[1].level).toBe('error');
    expect(calls[1].msg).toContain('tts');
  });

  it('fails the stack when push-to-talk is configured but no capture device exists', async () => {
    const h = make(
      { micEnabled: true },
      { mic: async () => ({ ok: false, error: 'no capture endpoint found' }) },
    );
    const report = await h.refresh();
    expect(report.ok).toBe(false);
    const mic = report.components.find(c => c.component === 'mic')!;
    expect(mic.status).toBe('error');
    expect(mic.error).toContain('capture endpoint');
  });

  it('reports the mic as disabled when push-to-talk is not configured', async () => {
    const h = make();
    const report = await h.refresh();
    expect(report.components.find(c => c.component === 'mic')!.status).toBe('disabled');
  });
});
