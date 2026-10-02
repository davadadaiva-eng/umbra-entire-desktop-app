/**
 * ToolExecutor — universal, schema-validated execution engine for connector
 * actions. The LLM NEVER executes API calls: it only names a tool and gives
 * arguments; this module validates, injects credentials, and performs HTTP.
 *
 * Two execution paths:
 *
 *   1. `executeTool(def, args, userId)` — ToolDefinition-based. Args are
 *      validated against the tool's JSON-Schema BEFORE any request, path
 *      placeholders are substituted from args, leftovers become query/body.
 *
 *   2. `execute(connectorId, endpoint, method, payload, userId)` — the
 *      legacy generic REST path, kept for AgentConnectorBridge /
 *      ConnectorApi compatibility. The hallucinated-prone
 *      `https://api.<id>.com` guess is GONE: connectors without a known
 *      base URL fail with a clear, feedable error instead of hitting
 *      random domains.
 *
 * Shared guarantees on both paths:
 *   - credentials resolved from ConnectorStore (AES-256-GCM at rest),
 *   - OAuth auto-refresh when expired,
 *   - retry with backoff on 429/5xx/network errors (Retry-After honored
 *     when the caller surfaces it),
 *   - response bodies pass through InjectionGuard.scrub before becoming
 *     LLM context.
 *
 * Uses HttpBridge (curl.exe) to bypass Node v24 TLS stack issues.
 */

import { HttpBridge } from '../agent/HttpBridge';
import { ConnectorStore } from './ConnectorStore';
import { MCP_CATALOG, findCatalogEntry } from './McpCatalog';
import { ToolDefinition, validateToolArgs } from './ToolDefinition';
import { curatedConnectorForCatalogId } from './curatedTools';
import { InjectionGuard } from '../agent/InjectionGuard';
import { getLogger } from '../Logger';

// ── Types ───────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  connector: string;
  endpoint: string;
  method: string;
  status: number;
  latencyMs: number;
  data: unknown;
  error?: string;
  /** Set when arguments failed schema validation (feed back to the LLM). */
  validationErrors?: string[];
  /** Set when the response body contained quarantined prompt-injection text. */
  injectionScrubbed?: boolean;
  /** Number of HTTP attempts actually made (1 = no retry). */
  attempts?: number;
}

export interface ExecuteOptions {
  /** Request timeout in milliseconds (default: 30_000). */
  timeoutMs?: number;
  /** Additional headers to send. */
  headers?: Record<string, string>;
  /** Skip token refresh attempt (useful for retry loops). */
  skipRefresh?: boolean;
}

export interface ToolExecutorOptions {
  /** Definition store for legacy-path schema lookup (optional). */
  ingestion?: { getForConnector(connectorId: string): ToolDefinition[] };
  /** When set, response bodies are scrubbed for prompt injection. */
  injectionGuard?: InjectionGuard;
  /** Executes MCP-transport tools via the router (wired at boot). */
  mcpCall?: (connectorId: string, tool: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Max HTTP attempts per call (default 3). */
  maxAttempts?: number;
  /**
   * Resolve the OAuth token endpoint + client for a connector's credentialKey.
   * Wired to OAuthConnector so refresh uses the same provider table as the
   * authorize step (the previous hardcoded 10-entry map fell back to a fake
   * `https://oauth.<key>.com/token` for everything else).
   */
  oauthClient?: (credentialKey: string) => { clientId: string; clientSecret?: string; tokenUrl: string } | undefined;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Fallback token endpoints for when no OAuthConnector resolver is injected.
 * Deliberately a short, honest list — the previous code guessed
 * `https://oauth.<key>.com/token` for anything unlisted, which 404'd silently.
 */
const TOKEN_ENDPOINTS: Record<string, string> = {
  google: 'https://oauth2.googleapis.com/token',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  github: 'https://github.com/login/oauth/access_token',
  slack: 'https://slack.com/api/oauth.v2.access',
  spotify: 'https://accounts.spotify.com/api/token',
  discord: 'https://discord.com/api/oauth2/token',
  dropbox: 'https://api.dropboxapi.com/oauth2/token',
  linear: 'https://api.linear.app/oauth/token',
  notion: 'https://api.notion.com/v1/oauth/token',
  figma: 'https://www.figma.com/api/oauth/token',
};

// Well-known base URLs (explicit allowlist — no domain guessing).
const KNOWN_BASE_URLS: Record<string, string> = {
  gmail: 'https://gmail.googleapis.com',
  'google-calendar': 'https://www.googleapis.com',
  'google-drive': 'https://www.googleapis.com',
  'google-docs': 'https://docs.googleapis.com',
  'google-sheets': 'https://sheets.googleapis.com',
  spotify: 'https://api.spotify.com',
  discord: 'https://discord.com',
  slack: 'https://slack.com',
  github: 'https://api.github.com',
  twitter: 'https://api.twitter.com',
  stripe: 'https://api.stripe.com',
  notion: 'https://api.notion.com',
  linear: 'https://api.linear.app',
  figma: 'https://api.figma.com',
  twitch: 'https://api.twitch.tv',
  dropbox: 'https://api.dropboxapi.com',
  'microsoft-365': 'https://graph.microsoft.com',
  onedrive: 'https://graph.microsoft.com',
  teams: 'https://graph.microsoft.com',
  'search-research-wikipedia': 'https://en.wikipedia.org',
};

// ── ToolExecutor ────────────────────────────────────────────────────

export class ToolExecutor {
  private store: ConnectorStore;
  private ingestion?: ToolExecutorOptions['ingestion'];
  private injectionGuard?: InjectionGuard;
  private mcpCall?: ToolExecutorOptions['mcpCall'];
  private maxAttempts: number;
  private oauthClient?: ToolExecutorOptions['oauthClient'];

  constructor(store: ConnectorStore, options: ToolExecutorOptions = {}) {
    this.store = store;
    this.ingestion = options.ingestion;
    this.injectionGuard = options.injectionGuard;
    this.mcpCall = options.mcpCall;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.oauthClient = options.oauthClient;
  }

  // ══════════════════════════════════════════════════════════════════
  // Path 1: ToolDefinition-based execution (schema-validated)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Execute a tool from its ToolDefinition. Validates `args` against
   * `def.parameters_schema` BEFORE building any request; validation
   * failures return a machine-readable result the agent loop can feed
   * back to the LLM for one corrective retry.
   */
  async executeTool(
    def: ToolDefinition,
    args: Record<string, unknown>,
    userId: string,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const started = Date.now();
    const base: Pick<ToolResult, 'connector' | 'endpoint' | 'method'> = {
      connector: def.connector_id,
      endpoint: def.endpoint_template ?? def.name,
      method: def.http_method ?? 'POST',
    };

    // 0. Schema validation gate — never let a malformed call leave.
    const validation = validateToolArgs(args ?? {}, def.parameters_schema);
    if (!validation.ok) {
      return {
        ...base,
        success: false,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error: `Invalid arguments for ${def.name}: ${validation.errors.join('; ')}`,
        validationErrors: validation.errors,
      };
    }

    // 1. MCP transport → delegate to the router callback.
    if (def.transport === 'mcp') {
      if (!this.mcpCall) {
        return {
          ...base,
          success: false,
          status: 0,
          latencyMs: Date.now() - started,
          data: null,
          error: `Tool ${def.tool_id} is an MCP tool but no MCP router is wired — cannot execute`,
        };
      }
      try {
        const data = await this.mcpCall(def.connector_id, def.name, args);
        return this.finish({ ...base, success: true, status: 200, latencyMs: Date.now() - started, data, attempts: 1 });
      } catch (err: any) {
        return {
          ...base,
          success: false,
          status: 0,
          latencyMs: Date.now() - started,
          data: null,
          error: err?.message || 'MCP tool call failed',
        };
      }
    }

    if (def.transport === 'webhook') {
      return {
        ...base,
        success: false,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error: `Webhook transport for ${def.tool_id} is not implemented yet`,
      };
    }

    // 2. REST transport.
    const auth = this.resolveAuth(def.credential_service ?? def.connector_id, userId, def.auth_type, options);
    if (auth.error) return { ...base, success: false, status: 0, latencyMs: Date.now() - started, data: null, error: auth.error };
    if (def.auth_type !== 'none' && !auth.headers['Authorization'] && !hasApiKeyHeader(auth.headers)) {
      return {
        ...base,
        success: false,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error: `User has not connected ${def.connector_id}. Connect it at /connectors`,
      };
    }

    if (!def.base_url) {
      return {
        ...base,
        success: false,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error: `Tool ${def.tool_id} has no base_url configured — connect the connector or supply an override`,
      };
    }

    // 3. Split args into path / query / body and build the URL.
    const { url, body } = buildRestRequest(def, args);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...auth.headers,
      ...options.headers,
    };

    // 4. Execute with retry.
    const result = await this.httpWithRetry({
      url,
      method: def.http_method ?? 'POST',
      headers,
      body: body ?? undefined,
      timeoutMs: options.timeoutMs ?? 30_000,
      started,
      base,
    });
    return this.finish({ ...result, connector: def.connector_id, endpoint: url, method: def.http_method ?? 'POST' });
  }

  // ══════════════════════════════════════════════════════════════════
  // Path 2: legacy generic REST execution (compatibility)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Execute a generic REST action against a connector.
   *
   * @param connectorId - The connector slug/id (e.g. 'gmail', 'spotify')
   * @param endpoint - API endpoint path (e.g. '/v1/me/player', '/messages')
   * @param method - HTTP method (GET, POST, PUT, DELETE, PATCH)
   * @param payload - Request body or query parameters
   * @param userId - User ID for credential lookup
   */
  async execute(
    connectorId: string,
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    payload: Record<string, unknown>,
    userId: string,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const started = Date.now();

    // 1. Look up connector in catalog
    const connector = findCatalogEntry(connectorId);
    if (!connector) {
      return {
        success: false,
        connector: connectorId,
        endpoint,
        method,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error: `Connector "${connectorId}" not found in catalog`,
      };
    }

    // 2. Get stored credentials
    const tokens = this.store.getDecryptedTokens(userId, connectorId);
    if (connector.authType !== 'none' && (!tokens || (!tokens.accessToken && !tokens.apiKey))) {
      return {
        success: false,
        connector: connectorId,
        endpoint,
        method,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error: `User has not connected ${connector.name}. Connect it at /connectors`,
      };
    }

    // 3. Auto-refresh OAuth token if expired
    let accessToken = tokens?.accessToken;
    if (connector.authType === 'oauth' && tokens?.refreshToken && !options.skipRefresh) {
      if (this.store.isExpired(userId, connectorId)) {
        try {
          accessToken = await this.refreshOAuthToken(connector, tokens.refreshToken, userId);
        } catch (err) {
          getLogger().warn({ connectorId, err: (err as Error).message }, 'OAuth refresh failed');
          return {
            success: false,
            connector: connectorId,
            endpoint,
            method,
            status: 0,
            latencyMs: Date.now() - started,
            data: null,
            error: `Token refresh failed for ${connector.name}. Please reconnect.`,
          };
        }
      }
    }

    // 4. Resolve base URL — catalog, curated schema, or explicit allowlist.
    //    NO domain guessing: unknown connectors fail with a feedable error.
    const curated = curatedConnectorForCatalogId(connectorId);
    const baseUrl = connector.baseUrl || curated?.baseUrl || KNOWN_BASE_URLS[connectorId] || '';
    if (!baseUrl) {
      return {
        success: false,
        connector: connectorId,
        endpoint,
        method,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error:
          `Connector "${connectorId}" has no API base URL configured. ` +
          `Set baseUrl on the connector (Settings → Connectors) or use one of its schema-validated tools.`,
      };
    }
    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };

    if (connector.authType === 'oauth' || connector.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${accessToken}`;
    } else if (connector.authType === 'apiKey') {
      const headerName = connector.apiKeyHeader || 'X-API-Key';
      headers[headerName] = tokens?.apiKey || accessToken || '';
    }

    // 5. Execute with retry.
    return this.httpWithRetry({
      url,
      method,
      headers,
      body: method === 'GET' ? undefined : payload,
      timeoutMs: options.timeoutMs ?? 30_000,
      started,
      base: { connector: connectorId, endpoint: url, method },
      params: method === 'GET' ? (payload as Record<string, string>) : undefined,
    });
  }

  // ── Shared internals ───────────────────────────────────────────────

  private async httpWithRetry(args: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Record<string, unknown> | undefined;
    timeoutMs: number;
    started: number;
    base: Pick<ToolResult, 'connector' | 'endpoint' | 'method'>;
    params?: Record<string, string>;
  }): Promise<ToolResult> {
    const maxAttempts = Math.max(1, this.maxAttempts);
    let lastError = 'Request failed';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await HttpBridge.request({
          url: args.url,
          method: args.method as 'GET',
          headers: args.headers,
          body: args.body,
          params: args.params,
          timeoutMs: args.timeoutMs,
        } as any);

        const out: ToolResult = {
          success: result.status >= 200 && result.status < 300,
          ...args.base,
          status: result.status,
          latencyMs: Date.now() - args.started,
          data: result.data,
          attempts: attempt,
        };
        if (!out.success) {
          out.error = `HTTP ${result.status}${typeof result.data === 'string' && result.data ? `: ${result.data.slice(0, 300)}` : ''}`;
        }

        // Retry on 429/5xx; surface other failures immediately.
        if (RETRYABLE_STATUS.has(result.status) && attempt < maxAttempts) {
          lastError = out.error ?? `HTTP ${result.status}`;
          getLogger().warn(
            { url: args.url, status: result.status, attempt, nextInMs: backoffMs(attempt) },
            'Retryable connector failure — backing off',
          );
          await sleep(backoffMs(attempt));
          continue;
        }
        return out;
      } catch (err: any) {
        lastError = err?.message || 'Request failed';
        // Network-level errors are retryable; give up after maxAttempts.
        if (attempt < maxAttempts) {
          getLogger().warn({ url: args.url, err: lastError, attempt }, 'Connector network error — retrying');
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }

    return {
      success: false,
      ...args.base,
      status: 0,
      latencyMs: Date.now() - args.started,
      data: null,
      error: lastError,
      attempts: maxAttempts,
    };
  }

  /** Scrub the result body through the InjectionGuard before it reaches the LLM. */
  private finish(result: ToolResult): ToolResult {
    if (this.injectionGuard && result.data != null) {
      try {
        const serialized = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
        const scrubbed = this.injectionGuard.scrub(serialized, 'connector-result');
        if (!scrubbed.clean) {
          getLogger().warn(
            { connector: result.connector, hits: scrubbed.hits.length },
            'Connector response contained prompt-injection patterns — quarantined before LLM use',
          );
          result.injectionScrubbed = true;
          try {
            result.data = JSON.parse(scrubbed.text);
          } catch {
            result.data = scrubbed.text;
          }
        }
      } catch {
        // Guard must never break execution.
      }
    }
    getLogger().info(
      { connector: result.connector, status: result.status, latencyMs: result.latencyMs },
      'Connector action executed',
    );
    return result;
  }

  /**
   * Resolve credentials for a service and build auth headers.
   * `none` auth returns empty headers without touching the store.
   */
  private resolveAuth(
    service: string,
    userId: string,
    authType: ToolDefinition['auth_type'],
    options: ExecuteOptions,
  ): { headers: Record<string, string>; error?: string } {
    if (authType === 'none') return { headers: {} };

    const tokens = this.store.getDecryptedTokens(userId, service);
    if (!tokens || (!tokens.accessToken && !tokens.apiKey)) {
      return { headers: {}, error: `User has not connected ${service}. Connect it at /connectors` };
    }

    const headers: Record<string, string> = {};
    if (authType === 'oauth' || authType === 'bearer') {
      headers['Authorization'] = `Bearer ${tokens.accessToken ?? tokens.apiKey ?? ''}`;
    } else if (authType === 'apiKey') {
      // Header name is chosen per connector; default to the generic one.
      // (Curated definitions carry api_key_header when it matters.)
      headers['X-API-Key'] = tokens.apiKey ?? tokens.accessToken ?? '';
    }
    return { headers };
  }

  /**
   * Refresh an OAuth token using the stored refresh token.
   */
  private async refreshOAuthToken(
    connector: { id: string; credentialKey?: string },
    refreshToken: string,
    userId: string,
  ): Promise<string> {
    const credKey = connector.credentialKey || connector.id;

    // Prefer the injected resolver (the real OAuthConnector provider table),
    // which knows both the token URL and the per-provider secret requirement.
    let tokenUrl: string | undefined;
    let clientId: string | undefined;
    let clientSecret: string | undefined;

    const resolved = this.oauthClient?.(credKey);
    if (resolved) {
      tokenUrl = resolved.tokenUrl;
      clientId = resolved.clientId;
      clientSecret = resolved.clientSecret;
    }

    if (!tokenUrl || !clientId) {
      const devCreds = this.store.getDeveloperCredentials(credKey);
      if (!devCreds) {
        throw new Error(`No developer credentials configured for ${credKey}. Add them at /admin/developer-apps`);
      }
      clientId = devCreds.clientId;
      clientSecret = devCreds.clientSecret;
      tokenUrl = TOKEN_ENDPOINTS[credKey];
    }

    if (!tokenUrl) {
      throw new Error(
        `No OAuth token endpoint known for "${credKey}" — add tokenUrl to the connector's OAuth client config`,
      );
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    if (clientSecret) body.set('client_secret', clientSecret);

    const response = await HttpBridge.post(tokenUrl, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }, 10000);

    const tokens = response.data;
    if (!tokens.access_token) {
      throw new Error('Token refresh did not return access_token');
    }

    this.store.saveConnection({
      userId,
      connectorId: connector.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in || 3600,
    });

    getLogger().info({ connectorId: connector.id }, 'OAuth token refreshed');
    return tokens.access_token;
  }

  /**
   * List all connectors a user has connected.
   */
  listUserConnections(userId: string): Array<{
    connectorId: string;
    connectorName: string;
    status: string;
    connectedAt: Date;
  }> {
    const connections = this.store.listConnections(userId);
    return connections.map(conn => {
      const catalog = findCatalogEntry(conn.connectorId);
      return {
        connectorId: conn.connectorId,
        connectorName: catalog?.name || conn.connectorId,
        status: conn.connectionStatus,
        connectedAt: conn.createdAt,
      };
    });
  }

  /**
   * Disconnect a user from a connector.
   */
  disconnect(userId: string, connectorId: string): boolean {
    return this.store.removeConnection(userId, connectorId);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function hasApiKeyHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(k => k.toLowerCase() !== 'authorization' && k.toLowerCase() !== 'content-type' && k.toLowerCase() !== 'accept');
}

/**
 * Build a REST request from a ToolDefinition + validated args:
 *   - `{placeholder}` segments in the template are substituted from args,
 *   - args that filled path slots are consumed,
 *   - GET/DELETE: remaining args become query parameters,
 *   - POST/PUT/PATCH: remaining args become the JSON body.
 */
function buildRestRequest(
  def: ToolDefinition,
  args: Record<string, unknown>,
): { url: string; body?: Record<string, unknown>; pathUsed: string[] } {
  const template = def.endpoint_template ?? '';
  const pathUsed: string[] = [];
  let path = template;

  for (const match of template.matchAll(/\{([^}]+)\}/g)) {
    const key = match[1];
    if (args[key] !== undefined) {
      path = path.replace(`{${key}}`, encodeURIComponent(String(args[key])));
      pathUsed.push(key);
    }
  }

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!pathUsed.includes(k) && v !== undefined) rest[k] = v;
  }

  const method = def.http_method ?? 'POST';
  let url = `${def.base_url ?? ''}${path}`;
  let body: Record<string, unknown> | undefined;

  if (method === 'GET' || method === 'DELETE') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v !== null && v !== undefined) qs.set(k, String(v));
    }
    const q = qs.toString();
    if (q) url += `?${q}`;
  } else {
    body = rest;
  }

  return { url, body, pathUsed };
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 400 * Math.pow(2, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
