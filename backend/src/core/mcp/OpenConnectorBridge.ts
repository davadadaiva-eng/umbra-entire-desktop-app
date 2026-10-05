/**
 * OpenConnectorBridge — Umbra OS gateway to oomol-lab/open-connector.
 *
 * Why a gateway (not a copy):
 *   - open-connector ships 1,500+ providers / 10,000+ Actions with lazy
 *     executors + generated catalog. Copying that source into Umbra would
 *     fork it and trigger Apache-2.0 redistribution duties on every file.
 *   - Running it as a sidecar (Docker `ghcr.io/oomol-lab/open-connector`
 *     or `npm i @oomol-lab/open-connector`) keeps Umbra a mere API client
 *     ("separable, merely links by name" — Apache-2.0 §1, not a Derivative
 *     Work) while exposing ALL providers instantly via /v1 + /mcp.
 *
 * Legal: Apache-2.0. See backend/THIRD-PARTY-NOTICES.md. Provider names /
 * trademarks belong to their owners, identification + interop only, no
 * endorsement. This file contains no open-connector source, only HTTP calls.
 *
 * Endpoints used (see open-connector docs/runtime-api.md):
 *   GET  /v1/health
 *   GET  /v1/providers / /v1/actions?service= / /v1/actions/:id
 *   POST /v1/actions/:id  { input, connectionName? } + Idempotency-Key?
 *   POST /mcp  (JSON-RPC: list_apps, list_connections, search_actions,
 *               get_action_guide, execute_action)
 *   GET  /openapi.json
 *
 * Env:
 *   OPENCONNECTOR_BASE_URL     default http://127.0.0.1:3000
 *   OPENCONNECTOR_RUNTIME_TOKEN  Bearer for /v1 + /mcp (optional locally)
 *   OPENCONNECTOR_ADMIN_TOKEN    Bearer for /api/* (optional locally)
 *   OPENCONNECTOR_TIMEOUT_MS     default 30_000
 */

export interface OpenConnectorOptions {
  baseUrl?: string;
  runtimeToken?: string;
  adminToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenConnectorActionSummary {
  actionId: string;
  service: string;
  name: string;
  description?: string;
  locallyExecutable?: boolean;
  catalogOnly?: boolean;
  needsCredential?: boolean;
}

export interface OpenConnectorExecuteResult {
  ok: boolean;
  status: number;
  data: unknown;
  executionId?: string;
  errorCode?: string;
  error?: string;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

export interface OpenConnectorProvider {
  /** Gateway service id (e.g. `github`, `gmail`, `hubspot`). */
  service: string;
  displayName: string;
  categories: string[];
  /** Normalized to Umbra auth vocabulary. */
  authTypes: Array<'none' | 'apiKey' | 'bearer' | 'oauth'>;
  description?: string;
}

export interface OpenConnectorAction {
  actionId: string;
  service: string;
  description?: string;
}

const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;
const HEALTH_CACHE_TTL_MS = 30 * 1000;

/** open-connector auth -> Umbra auth. Unknown values fall back to apiKey. */
function normalizeAuthTypes(raw: unknown): OpenConnectorProvider['authTypes'] {
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const map = (v: unknown): OpenConnectorProvider['authTypes'][number] => {
    const s = String(v ?? '').toLowerCase();
    if (s === 'no_auth' || s === 'none') return 'none';
    if (s === 'oauth2' || s === 'oauth') return 'oauth';
    if (s === 'bearer') return 'bearer';
    return 'apiKey';
  };
  const out = list.map(map);
  return out.length > 0 ? [...new Set(out)] : ['apiKey'];
}

function normalizeProvider(raw: any): OpenConnectorProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const service = String(raw.service ?? raw.id ?? raw.slug ?? '').trim();
  if (!service) return null;
  // Live shape: [{ id, displayName }] — test shape: plain strings. Both work.
  const cats = Array.isArray(raw.categories)
    ? raw.categories
      .map((c: unknown) => typeof c === 'string'
        ? c
        : String((c as any)?.displayName ?? (c as any)?.id ?? ''))
      .filter(Boolean)
    : raw.category ? [String(raw.category)] : [];
  const authRaw = raw.authTypes ?? raw.authType ?? raw.auth?.map?.((a: any) => a?.type) ?? raw.auth;
  return {
    service,
    displayName: String(raw.displayName ?? raw.name ?? raw.title ?? service),
    categories: cats.length > 0 ? cats : ['Other'],
    authTypes: normalizeAuthTypes(authRaw),
    description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : undefined,
  };
}

function extractArray(json: any): any[] {
  if (Array.isArray(json)) return json;
  for (const key of ['data', 'providers', 'apps', 'items', 'services']) {
    if (Array.isArray(json?.[key])) return json[key];
    if (Array.isArray(json?.data?.[key])) return json.data[key];
  }
  return [];
}

/**
 * Map an Umbra catalog id (`productivity-gmail`, `developer-github`,
 * `data-analytics-snowflake`) to a gateway service (`gmail`, `github`,
 * `snowflake`). Tries the full id first, then progressively strips leading
 * category segments so multi-word categories keep working. Returns undefined
 * when nothing matches — the caller then stays on the local path.
 */
export function resolveGatewayService(umbraId: string, services: Set<string> | string[]): string | undefined {
  const set = services instanceof Set ? services : new Set(services);
  if (set.has(umbraId)) return umbraId;
  const parts = umbraId.split('-').filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join('-');
    if (set.has(tail)) return tail;
  }
  // Underscored LLM tool ids (`productivity_gmail_execute_action`) → same walk.
  const uParts = umbraId.split('_').filter(Boolean);
  if (uParts.length > 1) {
    for (let i = 1; i < uParts.length; i++) {
      const tail = uParts.slice(i).join('-');
      if (set.has(tail)) return tail;
    }
  }
  return undefined;
}

function resolveConfig(opts: OpenConnectorOptions = {}): {
  base: string;
  runtimeToken: string;
  adminToken: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
} {
  const base = trimSlash(
    opts.baseUrl
      || process.env.OPENCONNECTOR_BASE_URL
      || 'http://127.0.0.1:3000',
  );
  return {
    base,
    runtimeToken: opts.runtimeToken ?? process.env.OPENCONNECTOR_RUNTIME_TOKEN ?? '',
    adminToken: opts.adminToken ?? process.env.OPENCONNECTOR_ADMIN_TOKEN ?? '',
    timeoutMs: opts.timeoutMs
      ?? Number(process.env.OPENCONNECTOR_TIMEOUT_MS || 30_000),
    fetchImpl: opts.fetchImpl ?? fetch,
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text.slice(0, 4000) };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

function authHeaders(runtimeToken: string, adminToken: string, admin: boolean): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const tok = admin ? adminToken : runtimeToken;
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

export class OpenConnectorBridge {
  private base: string;
  private runtimeToken: string;
  private adminToken: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private providerCache: { at: number; providers: OpenConnectorProvider[] } | null = null;
  private healthCache: { at: number; ok: boolean } | null = null;

  constructor(opts: OpenConnectorOptions = {}) {
    const c = resolveConfig(opts);
    this.base = c.base;
    this.runtimeToken = c.runtimeToken;
    this.adminToken = c.adminToken;
    this.timeoutMs = c.timeoutMs;
    this.fetchImpl = c.fetchImpl;
  }

  /** Base URL in use (for logs / health checks). */
  getBaseUrl(): string {
    return this.base;
  }

  /** Drop cached provider/health state (tests + forced refresh). */
  clearCache(): void {
    this.providerCache = null;
    this.healthCache = null;
  }

  /** Last fetched providers without network (sync — for readiness overlays). */
  cachedProviders(): OpenConnectorProvider[] {
    return this.providerCache?.providers ?? [];
  }

  /** GET /v1/health — { ok } when the sidecar is up. */
  async health(): Promise<{ ok: boolean; status: number }> {
    try {
      const { status, json } = await fetchJson(
        this.fetchImpl,
        `${this.base}/v1/health`,
        { method: 'GET', headers: authHeaders(this.runtimeToken, this.adminToken, false) },
        // Generous: loopback is normally ms-fast, but a cold/busy backend can
        // take 10s+ to turn its own event loop. Refused connections still
        // fail fast, so a downed sidecar degrades quickly.
        Math.min(this.timeoutMs, 30_000),
      );
      void json;
      return { ok: status >= 200 && status < 300, status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /** Cached availability probe — never throws, false when the sidecar is down. */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at < HEALTH_CACHE_TTL_MS) {
      return this.healthCache.ok;
    }
    const h = await this.health();
    this.healthCache = { at: now, ok: h.ok };
    return h.ok;
  }

  /**
   * All gateway providers (cached 5 min). Tries `/v1/providers`, falls back
   * to `/v1/apps`. Returns [] when the sidecar is down — callers stay on the
   * local catalog path. Never throws.
   */
  async listProviders(opts: { refresh?: boolean } = {}): Promise<OpenConnectorProvider[]> {
    const now = Date.now();
    if (!opts.refresh && this.providerCache && now - this.providerCache.at < PROVIDER_CACHE_TTL_MS) {
      return this.providerCache.providers;
    }
    for (const path of ['/v1/providers', '/v1/apps']) {
      try {
        const { status, json } = await fetchJson(
          this.fetchImpl,
          `${this.base}${path}`,
          { method: 'GET', headers: authHeaders(this.runtimeToken, this.adminToken, false) },
          // Same reasoning as health(): tolerate a busy host process.
          Math.min(this.timeoutMs, 60_000),
        );
        if (status < 200 || status >= 300) continue;
        const providers = extractArray(json).map(normalizeProvider).filter((p): p is OpenConnectorProvider => !!p);
        if (providers.length > 0) {
          this.providerCache = { at: now, providers };
          return providers;
        }
      } catch {
        return this.providerCache?.providers ?? [];
      }
    }
    return this.providerCache?.providers ?? [];
  }

  /** Live service-id set for `resolveGatewayService` (cached via listProviders). */
  async serviceSet(): Promise<Set<string>> {
    return new Set((await this.listProviders()).map(p => p.service));
  }

  /**
   * Full-text action search via MCP `search_actions` (falls back to a cached
   * `listActions` filter when the gateway only speaks HTTP).
   */
  async searchActions(query: string, limit = 5): Promise<OpenConnectorAction[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const res = await this.mcpCall('search_actions', { query: q, limit }) as any;
      const arr = extractArray(res?.result ?? res);
      const out = arr.map((a: any) => ({
        actionId: String(a?.actionId ?? a?.id ?? ''),
        service: String(a?.service ?? ''),
        description: typeof a?.description === 'string' ? a.description : undefined,
      })).filter((a: OpenConnectorAction) => !!a.actionId);
      if (out.length > 0) return out.slice(0, limit);
    } catch {
      // Fall through to the HTTP filter below.
    }
    try {
      const all = await this.listActions(undefined, 500);
      const toks = q.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      return all
        .filter(a => toks.some(t =>
          a.actionId.toLowerCase().includes(t) || a.service.toLowerCase().includes(t)))
        .slice(0, limit)
        .map(a => ({ actionId: a.actionId, service: a.service, description: a.description }));
    } catch {
      return [];
    }
  }

  /**
   * Mirror an API-key connection into the gateway so it can execute.
   * PUT /api/connections/:service. Best-effort — returns false (no throw)
   * when the sidecar is down so the local connect still succeeds.
   */
  async putConnection(service: string, apiKey: string, connectionName?: string): Promise<boolean> {
    try {
      const { status } = await fetchJson(
        this.fetchImpl,
        `${this.base}/api/connections/${encodeURIComponent(service)}`,
        {
          method: 'PUT',
          headers: authHeaders(this.runtimeToken, this.adminToken, true),
          body: JSON.stringify({
            authType: 'api_key',
            values: { apiKey },
            ...(connectionName ? { connectionName } : {}),
          }),
        },
        this.timeoutMs,
      );
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  /**
   * Start a gateway OAuth authorization for a bridge-only provider.
   * POST /api/oauth/authorizations → { authorizationUrl }. The UI flow is
   * identical to a native Umbra OAuth connect (redirect out, callback back).
   */
  async startOAuth(service: string, connectionName?: string): Promise<{ authorizationUrl: string }> {
    const { status, json } = await fetchJson(
      this.fetchImpl,
      `${this.base}/api/oauth/authorizations`,
      {
        method: 'POST',
        headers: authHeaders(this.runtimeToken, this.adminToken, true),
        body: JSON.stringify({ service, ...(connectionName ? { connectionName } : {}) }),
      },
      this.timeoutMs,
    );
    const url = json?.data?.authorizationUrl ?? json?.authorizationUrl;
    if (status < 200 || status >= 300 || !url) {
      // User-facing text names only the provider — the gateway itself is
      // invisible by design, so its name never appears in errors.
      throw new Error(json?.message || json?.error || `Could not start sign-in for ${service} (HTTP ${status})`);
    }
    return { authorizationUrl: String(url) };
  }

  /**
   * Raw provider REST via the gateway when no curated Action fits.
   * POST /v1/proxy/:service — endpoint must be a relative `/path`.
   */
  async proxy(
    service: string,
    endpoint: string,
    method: string,
    payload: Record<string, unknown> = {},
    connectionName?: string,
  ): Promise<OpenConnectorExecuteResult> {
    const headers: Record<string, string> = authHeaders(this.runtimeToken, this.adminToken, false);
    if (connectionName) headers['x-oo-connector-alias'] = connectionName;
    const m = method.toUpperCase();
    const { status, json } = await fetchJson(
      this.fetchImpl,
      `${this.base}/v1/proxy/${encodeURIComponent(service)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint,
          method: m,
          ...(m === 'GET' ? { query: payload } : { body: payload }),
        }),
      },
      this.timeoutMs,
    );
    if (status >= 200 && status < 300) {
      return { ok: true, status, data: json?.data ?? json, executionId: json?.meta?.executionId };
    }
    return {
      ok: false,
      status,
      data: json?.data ?? null,
      errorCode: json?.errorCode || json?.code,
      error: json?.message || json?.error || `HTTP ${status}`,
    };
  }
  /**
   * List actions, optionally filtered by provider service.
   * GET /v1/actions?service=github
   */
  async listActions(service?: string, limit = 100): Promise<OpenConnectorActionSummary[]> {
    const q = service ? `?service=${encodeURIComponent(service)}` : '';
    const { status, json } = await fetchJson(
      this.fetchImpl,
      `${this.base}/v1/actions${q}`,
      { method: 'GET', headers: authHeaders(this.runtimeToken, this.adminToken, false) },
      this.timeoutMs,
    );
    if (status < 200 || status >= 300) {
      throw new Error(`open-connector listActions failed: HTTP ${status}`);
    }
    const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return arr.slice(0, limit).map((a: any) => ({
      actionId: String(a.actionId || a.id || ''),
      service: String(a.service || service || ''),
      name: String(a.name || a.actionId || ''),
      description: a.description ? String(a.description) : undefined,
      locallyExecutable: a.locallyExecutable,
      catalogOnly: a.catalogOnly,
      needsCredential: a.needsCredential,
    })).filter((a: OpenConnectorActionSummary) => !!a.actionId);
  }

  /**
   * Execute one Action.
   * POST /v1/actions/:actionId  { input, connectionName? }
   * Pass idempotencyKey to make retries safe (server replays 24h).
   */
  async executeAction(
    actionId: string,
    input: Record<string, unknown> = {},
    opts: { connectionName?: string; idempotencyKey?: string } = {},
  ): Promise<OpenConnectorExecuteResult> {
    const headers: Record<string, string> = authHeaders(this.runtimeToken, this.adminToken, false);
    if (opts.connectionName) headers['x-oo-connector-alias'] = opts.connectionName;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const { status, json } = await fetchJson(
      this.fetchImpl,
      `${this.base}/v1/actions/${encodeURIComponent(actionId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ input, ...(opts.connectionName ? { connectionName: opts.connectionName } : {}) }),
      },
      this.timeoutMs,
    );
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        status,
        data: json?.data ?? json,
        executionId: json?.meta?.executionId,
      };
    }
    return {
      ok: false,
      status,
      data: json?.data ?? null,
      errorCode: json?.errorCode || json?.code,
      error: json?.message || json?.error || `HTTP ${status}`,
      executionId: json?.meta?.executionId,
    };
  }

  /**
   * MCP JSON-RPC passthrough — lets Umbra's agent hosts reuse the same
   * 5 discovery tools open-connector exposes at POST /mcp:
   * list_apps, list_connections, search_actions, get_action_guide,
   * execute_action (with optional connectionName, no silent fallback).
   */
  async mcpCall(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { status, json } = await fetchJson(
      this.fetchImpl,
      `${this.base}/mcp`,
      {
        method: 'POST',
        headers: { ...authHeaders(this.runtimeToken, this.adminToken, false), 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      },
      this.timeoutMs,
    );
    if (status < 200 || status >= 300) throw new Error(`open-connector /mcp ${tool} failed: HTTP ${status}`);
    if (json?.error) throw new Error(`open-connector /mcp ${tool} error: ${json.error.message || JSON.stringify(json.error).slice(0, 300)}`);
    return json?.result ?? json;
  }

  /** GET /api/connections (admin) — safe account labels only, never secrets. */
  async listConnections(): Promise<unknown> {
    const { status, json } = await fetchJson(
      this.fetchImpl,
      `${this.base}/api/connections`,
      { method: 'GET', headers: authHeaders(this.runtimeToken, this.adminToken, true) },
      this.timeoutMs,
    );
    if (status < 200 || status >= 300) throw new Error(`open-connector listConnections failed: HTTP ${status}`);
    return json?.data ?? json;
  }
}

/** Env template line for docs / setup scripts. */
export const OPENCONNECTOR_ENV_EXAMPLE = [
  '# open-connector sidecar (all 1,500+ providers via gateway — no code copied)',
  '# docker compose --profile connectors up -d  (serves http://127.0.0.1:3000)',
  'OPENCONNECTOR_BASE_URL=http://127.0.0.1:3000',
  '# Optional locally; REQUIRED when the sidecar is exposed beyond loopback:',
  '# OPENCONNECTOR_RUNTIME_TOKEN=oct_replace_me',
  '# OPENCONNECTOR_ADMIN_TOKEN=replace_me_admin',
  'OPENCONNECTOR_TIMEOUT_MS=30000',
].join('\n');
