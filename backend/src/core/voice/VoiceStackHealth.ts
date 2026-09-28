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
 *
 * Degraded vs error: a component is `degraded` when Umbra has a working
 * fallback for it (Piper down → Windows SAPI; faster-whisper down → the desktop
 * app's Web Speech API). A degraded component is *not* a hard failure — the
 * stack still reports `ok: true`, and the component carries the exact command
 * in `fix` so the UI can render "Voice degraded: start whisper with
 * `npm run whisper:stt-server`" instead of a red error. Only `error` — a
 * configured component with no working fallback at all — fails the stack.
 */

import { degradedHint } from './VoiceFallbacks';

export type VoiceStackComponent = 'stt' | 'tts' | 'asr' | 'cable' | 'loopback' | 'mic';

export type VoiceStackStatus = 'ok' | 'disabled' | 'degraded' | 'error';

export interface ComponentHealth {
  component: VoiceStackComponent;
  /** Whether this feature is enabled in config (disabled components don't fail the stack). */
  configured: boolean;
  ok: boolean;
  status: VoiceStackStatus;
  detail?: string;
  error?: string;
  /** Copy-pasteable command that restores this component (set when not ok). */
  fix?: string;
  /** What Umbra uses instead while this component is down. */
  fallback?: string;
  checkedAt: number;
}

export interface VoiceStackHealthReport {
  ok: boolean;
  components: ComponentHealth[];
  /** Configured components running on a fallback instead of their provider. */
  degraded: VoiceStackComponent[];
  /** Every distinct `fix` command, in component order — the "how to fix" list. */
  fixes: string[];
  /** One-line status for the UI, e.g. "Voice degraded: start whisper with …". */
  summary: string;
  checkedAt: number;
}

export interface ComponentProbe {
  ok: boolean;
  detail?: string;
  error?: string;
  /** Override the derived status (e.g. 'degraded' while a model is loading). */
  status?: VoiceStackStatus;
  /** Command that fixes this component. */
  fix?: string;
  /** What Umbra uses instead when this component is not ok. */
  fallback?: string;
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
    base.fallback = 'the last known-good voice path';
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
      fix: result.fix,
      fallback: result.fallback,
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

/** Build the one-line status the UI shows above the component list. */
function summarize(components: ComponentHealth[]): string {
  const broken = components.filter(c => c.configured && c.status !== 'ok' && c.status !== 'disabled');
  if (broken.length === 0) return 'Voice stack ready';

  const worst = broken.some(c => c.status === 'error') ? 'Voice error' : 'Voice degraded';
  const first = broken[0];
  const fix = first.fix ? ` — fix: ${first.fix}` : '';
  const rest = broken.length > 1 ? ` (+${broken.length - 1} more)` : '';
  const how = first.fallback ? `, using ${first.fallback} meanwhile` : '';
  return `${worst}: ${first.component} unavailable${how}${fix}${rest}`;
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
    const degraded = components
      .filter(c => c.configured && c.status === 'degraded')
      .map(c => c.component);
    const fixes = components
      .filter(c => c.configured && c.status !== 'ok' && c.status !== 'disabled' && c.fix)
      .map(c => c.fix as string)
      .filter((f, i, all) => all.indexOf(f) === i);
    this.report = {
      // A degraded component is running on a fallback, so it is not a failure:
      // only a component with no working fallback at all ('error') fails.
      ok: components.every(c => !c.configured || c.status !== 'error'),
      components,
      degraded,
      fixes,
      summary: summarize(components),
      checkedAt: Date.now(),
    };
    return this.report;
  }

  /** The last report (null before the first refresh). */
  snapshot(): VoiceStackHealthReport | null {
    return this.report
      ? {
          ...this.report,
          components: this.report.components.map(c => ({ ...c })),
          degraded: [...this.report.degraded],
          fixes: [...this.report.fixes],
        }
      : null;
  }

  /**
   * Log the boot-time picture. Degraded components warn (with the fix command
   * and the active fallback); only genuine errors log at error level. Never
   * throws, so a dead voice server can never block startup.
   */
  logReport(log: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }): VoiceStackHealthReport | null {
    const report = this.report;
    if (!report) return null;
    for (const c of report.components) {
      if (!c.configured || c.status === 'ok' || c.status === 'disabled') continue;
      const payload = {
        component: c.component,
        error: c.error,
        fallback: c.fallback,
        fix: c.fix,
        hint: c.fix ? degradedHint(c.component, c.fallback ?? 'a built-in fallback', c.fix) : c.detail,
      };
      if (c.status === 'error') log.error(payload, `Voice component "${c.component}" is unavailable and has no fallback`);
      else log.warn(payload, `Voice component "${c.component}" is degraded — Umbra keeps working via the fallback`);
    }
    return report;
  }
}
