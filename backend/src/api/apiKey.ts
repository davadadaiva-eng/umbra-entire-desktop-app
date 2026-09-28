/**
 * Umbra OS — shared caller API-key resolution.
 *
 * Single source of truth for the auth-namespace routes (`/api/auth/*`,
 * `/api/plan`). Precedence:
 *
 *   1. `Authorization: Bearer <key>`  — preferred, never logged.
 *   2. `?key=` query param             — compat only; logs a deprecation warning
 *                                       that names the route but NEVER the key
 *                                       (the query string is not logged either).
 *   3. `body.apiKey | body.api_key | body.key` — compat for POST/DELETE bodies.
 *      `key` is required here: the desktop client (`desktop/src/lib/backend.ts`
 *      authLoginKey / authPairDevice) posts `{ key }`, not `{ apiKey }`, and the
 *      API contract in `schemas.ts` (M14) already declares apiKey|api_key|key.
 *
 * This lives in its own module because both `ApiServer` and the
 * `routes/computer.ts` sub-router need it — the sub-router is matched first, so
 * duplicating the logic per file is how the two copies drifted apart.
 */
import type * as http from 'http';
import type { URL } from 'url';
import { getLogger } from '../core/Logger';

export interface ResolvedApiKey {
  key: string;
  via: 'header' | 'query' | 'body' | 'none';
  usedDeprecatedQuery: boolean;
}

/** Body field aliases accepted for the API key, in precedence order. */
const BODY_KEY_FIELDS = ['apiKey', 'api_key', 'key', 'token'] as const;

/**
 * Resolve the caller API key from the request. Never throws, never logs the key
 * value itself.
 */
export function resolveApiKey(
  req: http.IncomingMessage | undefined,
  url: URL,
  body?: Record<string, unknown>,
): ResolvedApiKey {
  const auth = String(req?.headers?.['authorization'] || '').trim();
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim()) return { key: m[1].trim(), via: 'header', usedDeprecatedQuery: false };
  }

  const q = String(url.searchParams.get('key') || '').trim();
  if (q) {
    // Compat only — warn once per request, without the key value.
    getLogger().warn(
      { route: `${req?.method || '?'} ${url.pathname}`, via: 'query' },
      'Deprecated ?key= query auth — use Authorization: Bearer header',
    );
    return { key: q, via: 'query', usedDeprecatedQuery: true };
  }

  for (const field of BODY_KEY_FIELDS) {
    const value = String(body?.[field] ?? '').trim();
    if (value) return { key: value, via: 'body', usedDeprecatedQuery: false };
  }

  return { key: '', via: 'none', usedDeprecatedQuery: false };
}
