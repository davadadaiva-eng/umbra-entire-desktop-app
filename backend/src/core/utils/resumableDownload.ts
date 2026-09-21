/**
 * resumableDownload — a small resumable HTTP downloader used for model files
 * cached under ~/.umbra/ (currently the Tesseract eng.traineddata.gz).
 *
 * Mirrors the resilience pattern of the VibeVoice-ASR pre-download
 * (scripts/vibevoice_asr_download.py): content-length + Range resume into a
 * .part file, retry with backoff on slow/flaky links, a per-attempt timeout,
 * and state reporting via the logger and an optional progress callback — so a
 * flaky first-run fetch degrades gracefully instead of failing hard.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

export interface ResumableDownloadOptions {
  /** Download URL. */
  url: string;
  /** Final destination path (the .part file is dest + '.part'). */
  dest: string;
  /** Attempts before giving up (default 5). */
  maxAttempts?: number;
  /** Per-attempt timeout in ms (default 60_000). */
  timeoutMs?: number;
  /** Base backoff in ms between attempts (doubles each retry, default 1_000). */
  backoffMs?: number;
  /** Called with bytes written so far and total size (when the server reports it). */
  onProgress?: (done: number, total?: number) => void;
}

export interface ResumableDownloadResult {
  ok: boolean;
  bytes: number;
  attempts: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Download `url` into `dest`, resuming from any existing `dest.part`. Never throws. */
export async function resumableDownload(options: ResumableDownloadOptions): Promise<ResumableDownloadResult> {
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs = options.backoffMs ?? 1_000;
  const part = `${options.dest}.part`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadAttempt(options, part, attempt);
    } catch (err) {
      const message = toError(err);
      getLogger().warn({ url: options.url, attempt, maxAttempts, error: message }, 'Download attempt failed — retrying');
      if (attempt === maxAttempts) {
        return {
          ok: false,
          bytes: fs.existsSync(part) ? fs.statSync(part).size : 0,
          attempts: attempt,
          error: message,
        };
      }
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  return { ok: false, bytes: 0, attempts: maxAttempts, error: 'download failed' };
}

async function downloadAttempt(options: ResumableDownloadOptions, part: string, attempt: number): Promise<ResumableDownloadResult> {
  const { url, dest, onProgress } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const resumeFrom = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {};
    if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;
    const response = await fetch(url, { headers, signal: controller.signal });

    // Range not satisfiable — the .part already holds the whole file (the
    // process died between the final write and the rename).
    if (response.status === 416 && fs.existsSync(part) && resumeFrom > 0) {
      fs.renameSync(part, dest);
      const bytes = fs.statSync(dest).size;
      getLogger().info({ url, bytes }, 'Download already complete');
      return { ok: true, bytes, attempts: attempt };
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) throw new Error('Response has no body');

    // Server answered 200 (ignoring our Range) — restart from zero.
    if (response.status === 200 && resumeFrom > 0) {
      getLogger().warn({ url }, 'Server ignored Range request — restarting download');
      fs.rmSync(part, { force: true });
    }
    const startAt = response.status === 206 ? resumeFrom : 0;
    const total = contentLength(response.headers, startAt);

    const out = fs.createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' });
    const reader = response.body.getReader();
    let done = startAt;
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>(resolve => out.once('drain', resolve));
      }
      done += value.byteLength;
      onProgress?.(done, total);
    }
    await new Promise<void>((resolve, reject) => out.end((err: Error | null) => (err ? reject(err) : resolve())));

    if (total !== undefined && done < total) {
      throw new Error(`Incomplete download: ${done} of ${total} bytes`);
    }

    fs.renameSync(part, dest);
    getLogger().info({ url, bytes: done }, `Download complete (attempt ${attempt})`);
    return { ok: true, bytes: done, attempts: attempt };
  } finally {
    clearTimeout(timer);
  }
}

/** Total file size from Content-Range (bytes X-Y/TOTAL) or Content-Length. */
function contentLength(headers: Headers, startAt: number): number | undefined {
  const range = headers.get('content-range');
  if (range) {
    const m = range.match(/\/(\d+)$/);
    if (m) return Number(m[1]);
  }
  const len = headers.get('content-length');
  if (len) return startAt + Number(len);
  return undefined;
}
