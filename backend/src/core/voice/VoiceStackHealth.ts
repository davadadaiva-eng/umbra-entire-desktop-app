/**
 * VoiceStackHealth — validates the whole voice stack at boot (and on demand)
 * and reports it in /api/status.
 *
 * Components probed:
 *   - stt       — configured STT provider is usable (whisper-local endpoint
 *                 reachable, openai key present)
 *   - tts       — configured TTS provider is installed/running
 *                 (local=SAPI, vibevoice=venv, voicebox=API up)
 *   - asr       — meeting diarization server is up (vibevoice)
 *   - cable     — the virtual audio cable is present (VB-Cable / named device)
 *   - loopback  — WASAPI loopback capture is available for hearing meetings
 *   - mic       — a microphone capture device is present for push-to-talk
 *
 * Disabled components are reported as `status: "disabled"` and never fail the
 * overall stack — only *configured* components count toward the result.
 */

export type VoiceStackComponent = 'stt' | 'tts' | 'asr' | 'cable' | 'loopback' | 'mic';

export interface ComponentHealth {
  component: VoiceStackComponent;
  /** Whether this feature is enabled in config (disabled components don't fail the stack). */
  configured: boolean;
  ok: boolean;
  status: 'ok' | 'disabled' | 'degraded' | 'error';
  detail?: string;
  error?: string;
  checkedAt: number;
}

export interface VoiceStackHealthReport {
  ok: boolean;
  components: ComponentHealth[];
  checkedAt: number;
}

export interface ComponentProbe {
  ok: boolean;
  detail?: string;
  error?: string;
  /** Override the derived status (e.g. 'degraded' while a model is loading). */
  status?: 'ok' | 'degraded' | 'error';
}

export type ComponentProbeFn = () => Promise<ComponentProbe>;

export interface VoiceStackProbes {
  stt?: ComponentProbeFn;
  tts?: ComponentProbeFn;
  asr?: ComponentProbeFn;
  cable?: ComponentProbeFn;
  loopback?: ComponentProbeFn;
  mic?: ComponentProbeFn;
}

export interface VoiceStackHealthConfig {
  sttProvider: 'none' | 'openai' | 'whisper-local' | 'voicebox' | 'faster-whisper';
  tts: 'none' | 'local' | 'vibevoice' | 'voicebox' | 'piper';
  asrProvider: 'none' | 'vibevoice' | 'whisper';
  audioCable: 'none' | 'auto' | string;
  loopbackEnabled: boolean;
  /** Microphone capture for push-to-talk (default false). */
  micEnabled?: boolean;
}

export interface VoiceStackHealthOptions {
  config: VoiceStackHealthConfig;
  probes?: VoiceStackProbes;
}

async function probeResult(component: VoiceStackComponent, configured: boolean, probe?: ComponentProbeFn): Promise<ComponentHealth> {
  const base: ComponentHealth = {
    component,
    configured,
    ok: true,
    status: configured ? 'ok' : 'disabled',
    checkedAt: Date.now(),
  };
  if (!configured) {
    base.detail = 'disabled in config';
    return base;
  }
  if (!probe) {
    base.ok = false;
    base.status = 'degraded';
    base.detail = 'no probe wired';
    return base;
  }
  try {
    // probe() never throws by contract, but guard anyway.
    const result = await probe();
    return {
      ...base,
      ok: result.ok,
      status: result.status ?? (result.ok ? 'ok' : 'error'),
      detail: result.detail,
      error: result.error,
      checkedAt: Date.now(),
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now(),
    };
  }
}

export class VoiceStackHealth {
  private options: VoiceStackHealthOptions;
  private report: VoiceStackHealthReport | null = null;

  constructor(options: VoiceStackHealthOptions) {
    this.options = options;
  }

  get config(): VoiceStackHealthConfig {
    return this.options.config;
  }

  /** Run every configured probe and cache the report. Never throws. */
  async refresh(): Promise<VoiceStackHealthReport> {
    const { config, probes } = this.options;
    const components = await Promise.all([
      probeResult('stt', config.sttProvider !== 'none', probes?.stt),
      probeResult('tts', config.tts !== 'none', probes?.tts),
      probeResult('asr', config.asrProvider !== 'none', probes?.asr),
      probeResult('cable', config.audioCable !== 'none' && config.audioCable !== undefined, probes?.cable),
      probeResult('loopback', config.loopbackEnabled, probes?.loopback),
      probeResult('mic', config.micEnabled === true, probes?.mic),
    ]);
    this.report = {
      ok: components.every(c => !c.configured || c.ok),
      components,
      checkedAt: Date.now(),
    };
    return this.report;
  }

  /** The last report (null before the first refresh). */
  snapshot(): VoiceStackHealthReport | null {
    return this.report ? { ...this.report, components: this.report.components.map(c => ({ ...c })) } : null;
  }
}
