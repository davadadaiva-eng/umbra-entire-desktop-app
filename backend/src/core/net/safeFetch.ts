/**
 * safeFetch — SSRF-safe server-side fetch for connectors/research.
 *
 * Uses the existing UrlGuard (validatePublicUrl) then performs a DNS-pinned
 * GET with redirects rejected, a 5MB cap, a 10s timeout, and sensitive
 * response headers stripped. No caller changes yet — new isolated util.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { validatePublicUrl } from '../browser/UrlGuard';

export const SAFE_FETCH_MAX_BYTES = 5_000_000;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;
const SAFE_FETCH_UA = 'UmbraOS/0.1 (read-only research)';

const STRIPPED_HEADERS = new Set([
  'set-cookie',
  'content-encoding',
  'transfer-encoding',
  'content-length',
  'location',
  'refresh',
]);

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function sanitizeHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function readPublicResource(
  input: string,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  return (async () => {
    const { url, address, family } = await validatePublicUrl(input);
    options.signal?.throwIfAborted();
    return await new Promise<SafeFetchResult>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        url,
        {
          method: 'GET',
          signal: options.signal,
          headers: {
            'User-Agent': SAFE_FETCH_UA,
            Accept: 'text/html,image/*,text/css,*/*;q=0.5',
            'Accept-Encoding': 'identity',
          },
          // Pin DNS to the validated public IP (SSRF guard).
          lookup: ((hostname: string, opts: unknown, cb: unknown) => {
            const callback = cb as (
              err: NodeJS.ErrnoException | null,
              address: string | { address: string; family: number }[],
              family: number,
            ) => void;
            const all = (
              opts as { all?: boolean } | undefined
            )?.all;
            if (all) {
              callback(null, [{ address, family }], 0);
            } else {
              callback(null, address, family);
            }
          }) as never,
        },
        (res) => {
          const status = res.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            res.resume();
            reject(
              new Error(
                'Redirects are blocked for safety. Provide the final canonical URL.',
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy(new Error('Resource exceeds size limit.'));
            } else {
              chunks.push(chunk);
            }
          });
          res.on('error', reject);
          res.on('end', () => {
            resolve({
              status,
              headers: sanitizeHeaders(
                res.headers as Record<string, string | string[] | undefined>,
              ),
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error('Remote resource timed out.')),
      );
      req.on('error', reject);
      options.signal?.addEventListener('abort', () => req.destroy(), {
        once: true,
      });
      req.end();
    });
  })();
}
