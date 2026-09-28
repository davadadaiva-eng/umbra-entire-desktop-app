/**
 * VoiceFallbacks — the single place that knows two things the rest of the
 * voice stack repeats everywhere:
 *
 *   1. Whether an error means "the server is not running" (→ degrade, there is
 *      a fallback) or "the request was wrong" (→ surface, there is not).
 *   2. The exact command that turns a degraded component back on.
 *
 * Umbra's config ships pointing at localhost STT/TTS ports (17510 / 17520 / …)
 * but nothing starts those servers automatically. Without this module a cold
 * machine reports the whole voice stack as `error`, and every speak/transcribe
 * call throws "server not running" — the UI then looks broken even though the
 * desktop app can still talk through the Web Speech API and Windows SAPI.
 */

/** Copy-pasteable fix for each voice component. Used verbatim in the UI. */
export const VOICE_FIX = {
  sttFasterWhisper: 'cd backend && npm run whisper:stt-server',
  sttWhisperLocal:
    'start a whisper.cpp server on :8080 (docs/voice-setup.md), or switch voice.sttProvider to faster-whisper',
  sttVoicebox: 'open the Voicebox app so http://127.0.0.1:17493 answers (docs/voicebox-setup.md)',
  sttBrowser:
    'the desktop app transcribes locally with the Web Speech API — no server needed; ' +
    'to transcribe headlessly run `cd backend && npm run whisper:stt-server`',
  ttsPiper: 'cd backend && npm run piper:tts-server',
  ttsVibeVoice: 'cd backend && npm run vibevoice:install',
  ttsVoicebox: 'open the Voicebox app so http://127.0.0.1:17493 answers (docs/voicebox-setup.md)',
  asrWhisper: 'cd backend && npm run whisper:asr-server',
  asrVibeVoice: 'cd backend && npm run vibevoice:asr-server',
  cable: 'install VB-Cable (https://vb-audio.com/Cable)',
  loopback: 'enable "Stereo Mix" in Windows Sound settings, or install VB-Cable',
  mic: 'connect a microphone and allow microphone access in Settings → Privacy',
} as const;

/** Netcode failures that mean "nothing is listening on that port". */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Message shapes undici/Node use when the peer never answers. */
const CONNECTION_MESSAGE =
  /fetch failed|failed to fetch|socket hang up|not running|unreachable|abort|timeout|timed out|network error/i;

export interface VoiceFailure {
  /** Short, user-facing reason. */
  error: string;
  /** What Umbra will do instead (the automatic fallback). */
  fallback: string;
  /** The command that restores the component. */
  fix: string;
}

/** Best-effort message for anything that was thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * True when the failure is "the server is not running" rather than "the server
 * answered and said no". Walks the `cause` chain because undici hides
 * `ECONNREFUSED` one level down.
 */
export function isConnectionError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const node = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (node.name === 'AbortError' || node.name === 'TimeoutError') return true;
    if (typeof node.code === 'string' && CONNECTION_CODES.has(node.code)) return true;
    cur = node.cause;
  }
  return CONNECTION_MESSAGE.test(errorMessage(err));
}

/**
 * Build the degraded-mode payload for a voice component whose server did not
 * answer, given what Umbra falls back to instead.
 */
export function unreachable(
  component: string,
  url: string,
  err: unknown,
  fallback: string,
  fix: string,
): VoiceFailure {
  return {
    error: `${component} is not running at ${url} (${errorMessage(err)})`,
    fallback,
    fix,
  };
}

/** Build the same payload for a component that is installed/running but busy. */
export function notReady(component: string, url: string, state: string, fallback: string, fix: string): VoiceFailure {
  return { error: `${component} at ${url} is not ready: ${state}`, fallback, fix };
}

/** The hint the UI shows for a degraded component. */
export function degradedHint(component: string, fallback: string, fix: string): string {
  return `Voice degraded: ${component} unavailable — using ${fallback}. Fix: ${fix}`;
}

/**
 * Cheap reachability probe for the voice microservices (GET `<url>/health`).
 * Used at boot so "nothing is listening on 17510/17520" is a *warning* with a
 * fix command rather than a silent stack of 500s later on.
 */
export async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/health', { method: 'GET', signal: controller.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
