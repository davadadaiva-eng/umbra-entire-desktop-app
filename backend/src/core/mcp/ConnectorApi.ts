/**
 * ConnectorApi — handler class implementing the connector marketplace API.
 *
 * Bridges the ApiServer routes to the ConnectorStore, ToolRetriever,
 * ToolExecutor, and OAuthConnector for the full connect/discover/execute flow.
 */

import { ConnectorStore, UserConnection, DeveloperCredential } from './ConnectorStore';
import { ToolDefinition } from './ToolDefinition';
import { HttpBridge } from '../agent/HttpBridge';
import { ToolRetriever, ConnectorTool } from './ToolRetriever';
import { ToolExecutor, ToolResult, ToolExecutorOptions } from './ToolExecutor';
import { AgentConnectorBridge, ConnectorAction, AgentConnectorResult } from '../agent/AgentConnectorBridge';
import { OAuthConnector, OAuthClient, OAUTH_PROVIDERS, oauthProviderSlugFor } from './OAuthConnector';
import { curatedConnectorForCatalogId, genericToolFor, normalizeBaseUrl } from './curatedTools';
import { MCP_CATALOG, findCatalogEntry, catalogByCategory, catalogCount, McpCatalogEntry } from './McpCatalog';
import { OpenConnectorBridge, OpenConnectorProvider, resolveGatewayService } from './OpenConnectorBridge';
import { getLogger } from '../Logger';

// ── Types ───────────────────────────────────────────────────────────

export interface ConnectorListResult {
  connectors: McpCatalogEntry[];
  total: number;
  categories: { category: string; count: number }[];
}

export interface ConnectorDetailResult {
  connector: McpCatalogEntry;
  isConnected: boolean;
  connection?: UserConnection;
}

export interface ConnectResult {
  action: 'oauth_redirect' | 'api_key_saved' | 'already_connected';
  authorizeUrl?: string;
  state?: string;
  message?: string;
}

export interface ConnectorStatusResult {
  connectorId: string;
  isConnected: boolean;
  status: string;
  tokenExpiresAt?: Date;
  lastUpdated?: Date;
}

// ── ConnectorApi ────────────────────────────────────────────────────

export class ConnectorApi {
  private store: ConnectorStore;
  private retriever: ToolRetriever;
  private executor: ToolExecutor;
  private bridge: AgentConnectorBridge;
  private oauth: OAuthConnector;
  /**
   * Optional gateway to oomol-lab/open-connector (1,500+ providers). When set
   * (see setOpenConnector), every public method transparently merges gateway
   * providers into results and falls back to gateway execution — the UI and
   * agent never see a difference between local and gateway connectors.
   * Unset (tests, offline): behavior is exactly the legacy local-only path.
   */
  private openConnector?: OpenConnectorBridge;
  /** Definition store for the schema browser (optional — tool framework). */
  private toolSchemas?: {
    listAll(): ToolDefinition[];
    getForConnector(connectorId: string): ToolDefinition[];
    count(): number;
    deleteForConnector(connectorId: string): number;
    ingestOpenApi(connectorId: string, spec: unknown, opts?: Record<string, unknown>): number;
    upsertDefinitions?(defs: ToolDefinition[]): number;
  };

  constructor(
    store: ConnectorStore,
    oauth?: OAuthConnector,
    /** Executor wiring (definition store, injection guard, MCP router). */
    executorOptions?: ToolExecutorOptions,
    /** Tool-definition store for listToolSchemas/getConnectorTools. */
    toolSchemas?: {
      listAll(): ToolDefinition[];
      getForConnector(connectorId: string): ToolDefinition[];
      count(): number;
      deleteForConnector(connectorId: string): number;
      ingestOpenApi(connectorId: string, spec: unknown, opts?: Record<string, unknown>): number;
      upsertDefinitions?(defs: ToolDefinition[]): number;
    },
  ) {
    this.store = store;
    this.oauth = oauth || new OAuthConnector();
    this.retriever = new ToolRetriever();
    this.executor = new ToolExecutor(store, {
      ...executorOptions,
      // Let refresh resolve the real provider token endpoint + client instead
      // of the executor's short fallback list.
      oauthClient: (credentialKey: string) => {
        const devCreds = store.getDeveloperCredentials(credentialKey);
        try {
          const resolved = this.oauth.resolve(credentialKey, {
            clientId: devCreds?.clientId || 'unknown',
            clientSecret: devCreds?.clientSecret || undefined,
          });
          return {
            clientId: devCreds?.clientId || 'unknown',
            clientSecret: devCreds?.clientSecret || undefined,
            tokenUrl: resolved.provider.tokenUrl,
          };
        } catch {
          return devCreds?.clientId
            ? {
                clientId: devCreds.clientId,
                clientSecret: devCreds.clientSecret || undefined,
                tokenUrl: '',
              }
            : undefined;
        }
      },
    });
    this.bridge = new AgentConnectorBridge(store, {
      executeToolDefinition: (def, args, userId) => this.executor.executeTool(def, args, userId),
    });
    this.toolSchemas = toolSchemas;  }

  /** Get the AgentConnectorBridge for wiring into the agent runtime. */
  getAgentConnectorBridge(): AgentConnectorBridge {
    return this.bridge;
  }

  /** Attach the open-connector gateway (wired once at boot in index.ts). */
  setOpenConnector(bridge: OpenConnectorBridge): void {
    this.openConnector = bridge;
    // Warm the provider cache so the sync getReadiness() overlay is
    // gateway-aware from the first UI paint. Fire-and-forget: a downed
    // sidecar just leaves the cache empty (local-only behavior).
    void bridge.listProviders().catch(() => {});
  }

  // ── Gateway transparency helpers (all best-effort, never throw) ──

  /** Live gateway providers, or [] when unset / unreachable. */
  private async gatewayProviders(): Promise<OpenConnectorProvider[]> {
    if (!this.openConnector) return [];
    try {
      if (!(await this.openConnector.isAvailable())) return [];
      return await this.openConnector.listProviders();
    } catch {
      return [];
    }
  }

  /**
   * Every service id the LOCAL catalog already covers (credentialKeys plus
   * all id tails, so `productivity-gmail` claims `gmail`). Gateway providers
   * outside this set are synthesized as extra catalog rows.
   */
  private localClaimedServices(): Set<string> {
    const s = new Set<string>();
    for (const e of MCP_CATALOG) {
      if (e.credentialKey) s.add(e.credentialKey);
      const parts = e.id.split('-').filter(Boolean);
      for (let i = 0; i < parts.length; i++) s.add(parts.slice(i).join('-'));
    }
    return s;
  }

  /** Present a gateway-only provider as a normal catalog entry (same shape). */
  private synthesizeGatewayEntry(p: OpenConnectorProvider): McpCatalogEntry {
    const authType = p.authTypes.includes('oauth') ? 'oauth'
      : p.authTypes.includes('bearer') ? 'bearer'
      : p.authTypes.length === 1 && p.authTypes[0] === 'none' ? 'none' : 'apiKey';
    return {
      id: p.service,
      name: p.displayName,
      category: p.categories[0] ?? 'Other',
      baseUrl: '',
      authType,
      apiKeyHeader: undefined,
      credentialKey: p.service,
      kind: 'verified',
      enabled: false,
      description: p.description ?? `${p.displayName} connector.`,
    };
  }

  /**
   * Resolve any connector id (local `<category>-<name>` or bare gateway
   * service) to its gateway service, or undefined when the gateway doesn't
   * carry it. Local-only callers are unaffected (returns undefined fast when
   * no bridge is attached).
   */
  private async gatewayServiceFor(connectorId: string): Promise<string | undefined> {
    if (!this.openConnector) return undefined;
    try {
      const services = await this.openConnector.serviceSet();
      if (services.size === 0) return undefined;
      if (services.has(connectorId)) return connectorId;
      const entry = findCatalogEntry(connectorId);
      if (entry?.credentialKey) {
        const hit = resolveGatewayService(entry.credentialKey, services);
        if (hit) return hit;
      }
      return resolveGatewayService(connectorId, services);
    } catch {
      return undefined;
    }
  }

  /**
   * Sync gateway lookup from the last cached provider list (no network).
   * Used by the sync getReadiness() overlay; async paths use
   * gatewayServiceFor() + gatewayProviders() instead.
   */
  private cachedGatewayInfo(connectorId: string): OpenConnectorProvider | undefined {
    const cached = this.openConnector?.cachedProviders() ?? [];
    if (cached.length === 0) return undefined;
    const services = new Set(cached.map(p => p.service));
    if (services.has(connectorId)) return cached.find(p => p.service === connectorId);
    const entry = findCatalogEntry(connectorId);
    if (entry?.credentialKey) {
      const hit = resolveGatewayService(entry.credentialKey, services);
      if (hit) return cached.find(p => p.service === hit);
    }
    const tail = resolveGatewayService(connectorId, services);
    return tail ? cached.find(p => p.service === tail) : undefined;
  }

  /** Local connection OR gateway connection counts as connected for the UI. */
  private async isConnectedAnywhere(connectorId: string, service: string | undefined, userId: string): Promise<boolean> {
    if (this.store.getConnection(userId, connectorId)?.connectionStatus === 'connected') return true;
    if (service && service !== connectorId
      && this.store.getConnection(userId, service)?.connectionStatus === 'connected') return true;
    if (!service || !this.openConnector) return false;
    try {
      const list = await this.openConnector.listConnections() as any;
      const arr = Array.isArray(list) ? list : Array.isArray(list?.connections) ? list.connections : [];
      return arr.some((c: any) =>
        c?.service === service || c?.app === service || c?.provider === service);
    } catch {
      return false;
    }
  }

  /** Mirror an API key into the gateway so it can execute (best-effort). */
  private async mirrorApiKeyToGateway(service: string | undefined, apiKey: string): Promise<void> {
    if (!service || !this.openConnector) return;
    try {
      await this.openConnector.putConnection(service, apiKey);
    } catch (err) {
      getLogger().warn({ service, err: (err as Error).message }, 'Gateway credential mirror failed — local connect still stands');
    }
  }

  /** Errors where a gateway retry could succeed (vs real provider answers). */
  private isGatewayCandidateError(err: string | undefined): boolean {
    if (!err) return true;
    const e = err.toLowerCase();
    return e.includes('no api base url')
      || e.includes('not found in catalog')
      || e.includes('has not connected')
      || e.includes('no base_url')
      || e.includes('no oauth')
      || e.includes('no endpoint known');
  }

  /** `github.get_current_user` → gateway Action; `/path` or URL → proxy. */
  private looksLikeGatewayAction(endpoint: string): boolean {
    if (!endpoint || endpoint.startsWith('/') || /^https?:\/\//i.test(endpoint)) return false;
    return endpoint.includes('.');
  }

  /**
   * List stored tool definitions (curated + ingested) with per-connector
   * connection state — powers the desktop "Tool Schemas" browser.
   */
  async listToolSchemas(opts: {
    q?: string;
    connectorId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    tools: ToolDefinition[];
    total: number;
    connectors: number;
    connection: Record<string, { connected: boolean; status?: string }>;
  }> {
    if (!this.toolSchemas) return { tools: [], total: 0, connectors: 0, connection: {} };
    let defs = opts.connectorId
      ? this.toolSchemas.getForConnector(opts.connectorId)
      : this.toolSchemas.listAll();
    const total = defs.length;
    if (opts.q?.trim()) {
      const q = opts.q.trim().toLowerCase();
      defs = defs.filter(d =>
        d.name.toLowerCase().includes(q)
        || d.natural_language_description.toLowerCase().includes(q)
        || d.connector_id.toLowerCase().includes(q));
    }
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(Math.max(1, opts.limit ?? 300), 1000);
    defs = defs.slice(offset, offset + limit);

    const connection: Record<string, { connected: boolean; status?: string }> = {};
    for (const cid of new Set(defs.map(d => d.connector_id))) {
      connection[cid] = this.connectionStateFor(cid);
    }
    return { tools: defs, total, connectors: Object.keys(connection).length, connection };
  }

  /** All stored tool schemas for one connector. */
  async getConnectorTools(connectorId: string): Promise<{
    connector: string;
    tools: ToolDefinition[];
    connection: { connected: boolean; status?: string };
  }> {
    if (!this.toolSchemas) return { connector: connectorId, tools: [], connection: { connected: false } };
    let tools = this.toolSchemas.getForConnector(connectorId);
    if (tools.length === 0) {
      // Curated defs live under `curated-<slug>` while connections/catalog use
      // other prefixes — fall back to matching on the id's trailing segment
      // (`search-research-wikipedia` ↔ `curated-wikipedia`).
      const tail = connectorId.split('-').pop() ?? '';
      if (tail) {
        tools = this.toolSchemas.listAll().filter(d =>
          d.connector_id === connectorId
          || d.connector_id.endsWith(`-${tail}`)
          || connectorId.endsWith(`-${d.connector_id}`));
      }
    }
    return { connector: connectorId, tools, connection: this.connectionStateFor(connectorId) };
  }

  /**
   * Map a stored definition's connector_id (e.g. `curated-gmail`,
   * `search-research-wikipedia`) to the user's connection state. Curated
   * ids match catalog/connection ids by suffix so `curated-gmail` lights up
   * for a `communication-gmail` login.
   */
  private connectionStateFor(connectorId: string): { connected: boolean; status?: string } {
    const conns = this.store.listConnections('default');
    const exact = conns.find(c => c.connectorId === connectorId);
    if (exact) return { connected: exact.connectionStatus === 'connected', status: exact.connectionStatus };
    const parts = connectorId.replace(/^curated-/, '').split('-');
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(i).join('-');
      const hit = conns.find(c => c.connectorId === candidate || c.connectorId.endsWith(`-${candidate}`));
      if (hit) return { connected: hit.connectionStatus === 'connected', status: hit.connectionStatus };
    }
    return { connected: false };
  }

  /**
   * Ingest an OpenAPI/Swagger spec for one connector on demand — grows the
   * tool catalog without code changes.
   *
   *   - `spec` (inline JSON object) or `specUrl` (fetched server-side over
   *     curl.exe),
   *   - replace semantics by default: prior definitions for the connector
   *     are removed so a re-ingested spec never leaves stale tools behind,
   *   - baseUrl / authType / apiKeyHeader default to the catalog entry when
   *     the connector is a known one (explicit request values win).
   *
   * The CALLER owns the vector re-index (boot index.ts wires the registry);
   * this method is pure ingestion + connection-agnostic storage.
   */
  async ingestOpenApiSpec(opts: {
    connectorId: string;
    spec?: unknown;
    specUrl?: string;
    baseUrl?: string;
    authType?: string;
    apiKeyHeader?: string;
    /** Default true — delete the connector's previous definitions first. */
    replace?: boolean;
    maxTools?: number;
  }): Promise<{
    connectorId: string;
    ingested: number;
    removed: number;
    total: number;
    replaced: boolean;
    baseUrl?: string;
    authType?: string;
    catalogMatch: boolean;
  }> {
    if (!this.toolSchemas) throw new Error('Tool ingestion store not configured on this node');
    const connectorId = String(opts.connectorId || '').trim();
    if (!connectorId) throw new Error('connectorId is required');
    if (opts.spec === undefined && !opts.specUrl) throw new Error('spec or specUrl is required');

    // Fetch the spec when a URL is given (curl.exe — same TLS bypass as the executor).
    let spec = opts.spec;
    let specSource = 'inline';
    if (spec === undefined && opts.specUrl) {
      const res = await HttpBridge.get(opts.specUrl, undefined, { Accept: 'application/json' }, 30_000);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Spec fetch failed: HTTP ${res.status}`);
      }
      if (res.data === null || typeof res.data !== 'object') {
        throw new Error('Spec URL did not return a JSON document (OpenAPI 3.x or Swagger 2.0)');
      }
      spec = res.data;
      specSource = 'url';
    }

    // Defaults from the catalog entry when this connector is a known one;
    // otherwise fall back to the spec's own `servers[0].url` (OpenAPI 3.x) or
    // `host` base (Swagger 2.0 declared via baseUrl by the caller).
    const entry = findCatalogEntry(connectorId);
    const authMap: Record<string, ToolDefinition['auth_type']> = { none: 'none', apiKey: 'apiKey', bearer: 'bearer', oauth: 'oauth' };
    const authType = authMap[String(opts.authType ?? entry?.authType ?? 'none')] ?? undefined;
    const specServers = (spec && typeof spec === 'object'
      ? (spec as { servers?: Array<string | { url?: string }> }).servers
      : undefined) ?? [];
    const firstServer = specServers[0];
    const specBaseUrl = typeof firstServer === 'string'
      ? firstServer
      : (firstServer && typeof firstServer.url === 'string' ? firstServer.url : undefined);
    // Only absolute URLs are routable — the executor concatenates
    // `${base_url}${endpoint_template}`, so a spec's relative `servers[0].url`
    // (e.g. "/api/v1") would produce an unusable request target.
    const isAbsolute = (u: string) => /^https?:\/\/[^\s]+$/i.test(u);
    const specBase = specBaseUrl && specBaseUrl.trim() && isAbsolute(specBaseUrl.trim())
      ? specBaseUrl.trim() : undefined;
    const declared = opts.baseUrl ?? entry?.baseUrl;
    const baseUrl = declared && declared.trim() ? declared.trim() : specBase;
    const apiKeyHeader = opts.apiKeyHeader ?? entry?.apiKeyHeader ?? undefined;

    // Replace semantics: drop the connector's previous definitions first.
    const replace = opts.replace !== false;
    const removed = replace ? this.toolSchemas.deleteForConnector(connectorId) : 0;

    const ingested = this.toolSchemas.ingestOpenApi(connectorId, spec, {
      baseUrl,
      authType,
      apiKeyHeader,
      category: entry?.category,
      maxTools: opts.maxTools,
    });
    if (ingested === 0) {
      throw new Error('Spec contains no supported REST operations (checked GET/POST/PUT/PATCH/DELETE paths)');
    }

    getLogger().info(
      { connectorId, ingested, removed, specSource, catalogMatch: !!entry },
      'On-demand OpenAPI ingestion complete',
    );
    return {
      connectorId,
      ingested,
      removed,
      total: this.toolSchemas.count(),
      replaced: replace && removed > 0,
      baseUrl,
      authType,
      catalogMatch: !!entry,
    };
  }

  /**
   * Per-connector readiness — what a user must actually do to connect this
   * connector. The catalog advertises ~3,900 entries but most need a secret or
   * a provider OAuth app before they can be called, so the UI reports the real
   * state instead of implying everything is one click away.
   *
   *   ready          — no auth needed (local databases, Wikipedia, git)
   *   connected      — already authorized for this user
   *   needs_key      — paste an API key / bearer token (we know the endpoint)
   *   needs_oauth_app— provider is known; user supplies clientId (+secret)
   *   needs_setup    — no endpoint/tool schema known yet
   */
  getReadiness(connectorId: string, userId = 'default'): {
    connectorId: string;
    state: 'ready' | 'connected' | 'needs_key' | 'needs_oauth_app' | 'needs_setup';
    authType: string;
    hasBaseUrl: boolean;
    hasTools: boolean;
    provider?: string;
    action: string;
  } {
    const entry = findCatalogEntry(connectorId);
    const key = entry?.credentialKey || connectorId;
    const localHasBaseUrl = Boolean(
      normalizeBaseUrl(entry?.baseUrl) || curatedConnectorForCatalogId(connectorId),
    );
    // Gateway overlay (sync, cached): a gateway-carried provider is routable
    // and executable even when the local catalog has no endpoint for it.
    const gw = this.cachedGatewayInfo(connectorId);
    const hasBaseUrl = localHasBaseUrl || !!gw;
    const toolCount = this.toolSchemas ? this.toolSchemas.getForConnector(connectorId).length : 0;
    // A connector is callable when it has stored/curated definitions OR the
    // generic REST path can route it (known base URL → `baseUrl + endpoint`;
    // otherwise a full https:// URL works as endpoint override). The generic
    // `call_api` fallback guarantees the first half for every entry.
    // A gateway-carried provider is additionally callable via the sidecar.
    const hasTools = toolCount > 0
      || Boolean(curatedConnectorForCatalogId(connectorId))
      || hasBaseUrl
      || !!gw;

    const connection = this.store.getConnection(userId, connectorId);
    if (connection?.connectionStatus === 'connected') {
      return {
        connectorId, state: 'connected', authType: entry?.authType ?? 'none',
        hasBaseUrl, hasTools, action: 'Connected',
      };
    }

    if (entry?.authType === 'none') {
      return { connectorId, state: 'ready', authType: 'none', hasBaseUrl, hasTools, action: 'Connect' };
    }

    if (entry?.authType === 'oauth') {
      const slug = oauthProviderSlugFor(key);
      if (slug) {
        const configured = this.store.getDeveloperCredentials(key) !== null;
        return {
          connectorId, state: 'needs_oauth_app', authType: 'oauth', hasBaseUrl, hasTools,
          provider: OAUTH_PROVIDERS[slug]?.name ?? slug,
          action: configured ? 'Authorize' : 'Add OAuth app credentials, then authorize',
        };
      }
      if (gw?.authTypes.includes('oauth')) {
        return {
          connectorId, state: 'needs_oauth_app', authType: 'oauth', hasBaseUrl, hasTools,
          provider: gw.displayName,
          action: 'Authorize',
        };
      }
      return {
        connectorId, state: 'needs_setup', authType: 'oauth', hasBaseUrl, hasTools,
        action: 'No OAuth endpoints known for this provider',
      };
    }

    // Gateway-only provider with no local row (entry === undefined).
    if (!entry && gw) {
      if (gw.authTypes.length === 1 && gw.authTypes[0] === 'none') {
        return { connectorId, state: 'ready', authType: 'none', hasBaseUrl, hasTools, action: 'Connect' };
      }
      if (gw.authTypes.includes('oauth')) {
        return {
          connectorId, state: 'needs_oauth_app', authType: 'oauth', hasBaseUrl, hasTools,
          provider: gw.displayName,
          action: 'Authorize',
        };
      }
      return {
        connectorId, state: 'needs_key', authType: 'apiKey',
        hasBaseUrl, hasTools, action: 'Paste API key',
      };
    }

    if (hasBaseUrl) {
      return {
        connectorId, state: 'needs_key', authType: entry?.authType ?? 'apiKey',
        hasBaseUrl, hasTools, action: 'Paste API key',
      };
    }

    return {
      connectorId, state: 'needs_setup', authType: entry?.authType ?? 'apiKey',
      hasBaseUrl, hasTools, action: 'No endpoint known — ingest a spec first',
    };
  }

  /** Readiness for every catalog entry, with aggregate counts. */
  getReadinessSummary(userId = 'default'): {
    counts: Record<string, number>;
    connectors: ReturnType<ConnectorApi['getReadiness']>[];
  } {
    const connectors = MCP_CATALOG.map(c => this.getReadiness(c.id, userId));
    const counts: Record<string, number> = {};
    for (const c of connectors) counts[c.state] = (counts[c.state] ?? 0) + 1;
    return { counts, connectors };
  }

  /**
   * Ensure a connector has callable tool schemas, ingesting its OpenAPI spec
   * on demand when it has none.
   *
   * This is what turns a name-only catalog row into a usable connector: the
   * spec is fetched once, converted to ToolDefinitions, indexed for vector
   * retrieval, and the derived `baseUrl` is persisted back onto the catalog
   * entry so the executor can route calls.
   *
   * Safe to call repeatedly — already-ingested connectors short-circuit.
   */
  async ensureConnectorTools(connectorId: string, opts: { force?: boolean } = {}): Promise<{
    connectorId: string;
    ingested: number;
    alreadyIndexed: boolean;
    baseUrl?: string;
    source: 'curated' | 'spec' | 'generic' | 'none';
  }> {
    const existing = this.toolSchemas?.getForConnector(connectorId) ?? [];
    if (existing.length > 0 && !opts.force) {
      return { connectorId, ingested: existing.length, alreadyIndexed: true, source: 'curated' };
    }

    // Curated tools are in-process, not in the definition store — check them too.
    const curated = curatedConnectorForCatalogId(connectorId);
    if (curated && !opts.force) {
      return { connectorId, ingested: 0, alreadyIndexed: true, baseUrl: curated.baseUrl, source: 'curated' };
    }

    const entry = findCatalogEntry(connectorId);
    if (!entry) throw new Error(`Connector "${connectorId}" not found`);
    if (!this.toolSchemas) throw new Error('Tool ingestion store not configured on this node');

    const specUrl = entry.specUrl;
    if (!specUrl) {
      // No OpenAPI spec known — synthesize the generic `call_api` fallback so
      // the connector is still discoverable AND executable (generic REST path:
      // `baseUrl + endpoint`, or a full https:// URL override when no base
      // URL is known yet). This is what makes every catalog entry callable.
      const generic = genericToolFor({
        id: connectorId,
        name: entry.name,
        category: entry.category,
        baseUrl: entry.baseUrl || undefined,
        authType: entry.authType,
        credentialKey: entry.credentialKey,
        apiKeyHeader: entry.apiKeyHeader,
      });
      const stored = this.toolSchemas.upsertDefinitions?.([generic]) ?? 0;
      getLogger().info(
        { connectorId, baseUrl: generic.base_url },
        'Generic fallback tool ensured (no OpenAPI spec known)',
      );
      return {
        connectorId,
        ingested: stored > 0 ? stored : 1,
        alreadyIndexed: false,
        baseUrl: generic.base_url,
        source: 'generic',
      };
    }

    const result = await this.ingestOpenApiSpec({
      connectorId,
      specUrl,
      baseUrl: entry.baseUrl || undefined,
      authType: entry.authType,
      apiKeyHeader: entry.apiKeyHeader,
    });

    return {
      connectorId,
      ingested: result.ingested,
      alreadyIndexed: false,
      baseUrl: result.baseUrl,
      source: 'spec',
    };
  }

  /**
   * List all connectors with search, category filter, and pagination.
   */
  async listConnectors(opts: {
    q?: string;
    category?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<ConnectorListResult> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const providers = await this.gatewayProviders();
    if (providers.length === 0) {
      const connectors = this.retriever.searchConnectors(opts.q || '', {
        category: opts.category,
        limit,
        offset,
      });

      // Total count (filtered, no AI)
      const total = opts.q
        ? this.retriever.searchConnectors(opts.q, { category: opts.category }).length
        : this.retriever.searchConnectors('').length;

      const categories = this.retriever.getCategories();

      return { connectors, total, categories };
    }

    // Gateway attached: merge local catalog + gateway-only providers into one
    // seamless list (gateway rows use the same McpCatalogEntry shape, so the
    // UI can't tell them apart). Local rows win on overlap.
    const claimed = this.localClaimedServices();
    const q = (opts.q || '').trim().toLowerCase();
    const extra = providers
      .filter(p => !claimed.has(p.service))
      .filter(p => !opts.category || p.categories.includes(opts.category))
      .filter(p => !q
        || p.service.includes(q)
        || p.displayName.toLowerCase().includes(q)
        || (p.description ?? '').toLowerCase().includes(q)
        || p.categories.some(c => c.toLowerCase().includes(q)))
      .map(p => this.synthesizeGatewayEntry(p));

    const allLocal = this.retriever.searchConnectors(opts.q || '', {
      category: opts.category,
    });
    // Exact service/name matches jump the queue so a gateway-only provider
    // the user asked for by name is never buried under name-only local rows.
    const qNorm = (opts.q || '').trim().toLowerCase();
    const isExact = (e: McpCatalogEntry) =>
      e.id === qNorm || e.name.toLowerCase() === qNorm;
    const [exactExtra, restExtra] = extra.reduce<[McpCatalogEntry[], McpCatalogEntry[]]>(
      ([a, b], e) => { (isExact(e) ? a : b).push(e); return [a, b]; }, [[], []]);
    const merged = [...exactExtra, ...allLocal, ...restExtra];
    const page = merged.slice(offset, offset + limit);

    const catMap = new Map<string, number>();
    for (const c of this.retriever.getCategories()) catMap.set(c.category, c.count);
    for (const e of extra) catMap.set(e.category, (catMap.get(e.category) ?? 0) + 1);
    const categories = [...catMap.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    return { connectors: page, total: merged.length, categories };
  }

  /**
   * Get a single connector by ID.
   */
  async getConnector(id: string, userId?: string): Promise<ConnectorDetailResult> {
    const connector = findCatalogEntry(id);
    if (connector) {
      let isConnected = false;
      let connection: UserConnection | undefined;

      if (userId) {
        connection = this.store.getConnection(userId, id) || undefined;
        isConnected = connection?.connectionStatus === 'connected';
        if (!isConnected) {
          const service = await this.gatewayServiceFor(id);
          isConnected = await this.isConnectedAnywhere(id, service, userId);
        }
      }

      return { connector, isConnected, connection };
    }

    // Not local — maybe a gateway-only provider (e.g. `hubspot`). Same shape.
    const providers = await this.gatewayProviders();
    const services = new Set(providers.map(p => p.service));
    const resolved = services.has(id) ? id : resolveGatewayService(id, services);
    const hit = providers.find(p => p.service === (resolved ?? id));
    if (!hit) {
      throw new Error(`Connector "${id}" not found`);
    }
    const entry = this.synthesizeGatewayEntry(hit);
    let isConnected = false;
    let connection: UserConnection | undefined;
    if (userId) {
      connection = this.store.getConnection(userId, id)
        || this.store.getConnection(userId, hit.service)
        || undefined;
      isConnected = connection?.connectionStatus === 'connected'
        || await this.isConnectedAnywhere(id, hit.service, userId);
    }
    return { connector: entry, isConnected, connection };
  }

  /**
   * Get all categories with counts.
   */
  async getConnectorCategories(): Promise<{ category: string; count: number }[]> {
    const local = await this.retriever.getCategories();
    const providers = await this.gatewayProviders();
    if (providers.length === 0) return local;
    const claimed = this.localClaimedServices();
    const catMap = new Map(local.map(c => [c.category, c.count]));
    for (const p of providers) {
      if (claimed.has(p.service)) continue;
      for (const c of p.categories) catMap.set(c, (catMap.get(c) ?? 0) + 1);
    }
    return [...catMap.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Start OAuth flow or save API key for a connector.
   */
  async connectConnector(
    id: string,
    opts: { apiKey?: string; redirectUri?: string; userId?: string },
  ): Promise<ConnectResult> {
    const connector = findCatalogEntry(id);
    if (!connector) {
      // Gateway-only provider — identical UX, no local catalog row needed.
      return this.connectGatewayOnly(id, opts);
    }

    const userId = opts.userId || 'default';

    // Check if already connected
    const existing = this.store.getConnection(userId, id);
    if (existing?.connectionStatus === 'connected') {
      return { action: 'already_connected', message: `${connector.name} is already connected` };
    }

    // API Key connection
    if (opts.apiKey) {
      this.store.saveConnection({
        userId,
        connectorId: id,
        apiKey: opts.apiKey,
      });

      getLogger().info({ connectorId: id, userId }, 'API key connection saved');
      // Mirror into the gateway so it can execute too (best-effort).
      const service = await this.gatewayServiceFor(id);
      await this.mirrorApiKeyToGateway(service, opts.apiKey);
      return {
        action: 'api_key_saved',
        message: `${connector.name} connected via API key`,
      };
    }

    // OAuth connection
    if (connector.authType === 'oauth') {
      const devCreds = this.store.getDeveloperCredentials(connector.credentialKey || id);
      if (!devCreds) {
        throw new Error(
          `No OAuth credentials configured for ${connector.name}. ` +
          `Add them at /api/admin/credentials`
        );
      }

      const client: OAuthClient = {
        clientId: devCreds.clientId,
        clientSecret: devCreds.clientSecret,
        scopes: devCreds.scopes,
      };

      const redirectUri = opts.redirectUri || `http://localhost:8787/api/mcp/oauth/callback`;
      // Resolve against the CREDENTIAL KEY — the provider table is keyed
      // `gmail`, not `productivity-gmail`.
      const key = connector.credentialKey || id;
      const { authorizeUrl, state } = this.oauth.begin(key, client, redirectUri);

      return {
        action: 'oauth_redirect',
        authorizeUrl,
        state,
        message: `Redirect to ${connector.name} to authorize`,
      };
    }

    // Non-OAuth connectors without API key
    throw new Error(
      `${connector.name} uses ${connector.authType} authentication. ` +
      `Provide an API key or configure OAuth credentials.`
    );
  }

  /**
   * Connect flow for gateway-only providers (no local catalog row). Same
   * ConnectResult shape as native connects: API keys save locally (and are
   * mirrored into the gateway), OAuth returns an authorize redirect.
   */
  private async connectGatewayOnly(
    id: string,
    opts: { apiKey?: string; redirectUri?: string; userId?: string },
  ): Promise<ConnectResult> {
    const providers = await this.gatewayProviders();
    const services = new Set(providers.map(p => p.service));
    const resolved = services.has(id) ? id : resolveGatewayService(id, services);
    const hit = providers.find(p => p.service === (resolved ?? id));
    if (!hit) {
      throw new Error(`Connector "${id}" not found`);
    }
    const service = hit.service;
    const userId = opts.userId || 'default';

    const existing = this.store.getConnection(userId, id)
      ?? this.store.getConnection(userId, service);
    if (existing?.connectionStatus === 'connected') {
      return { action: 'already_connected', message: `${hit.displayName} is already connected` };
    }

    if (opts.apiKey) {
      this.store.saveConnection({ userId, connectorId: id, apiKey: opts.apiKey });
      getLogger().info({ connectorId: id, userId, via: 'gateway' }, 'API key connection saved');
      await this.mirrorApiKeyToGateway(service, opts.apiKey);
      return { action: 'api_key_saved', message: `${hit.displayName} connected via API key` };
    }

    if (hit.authTypes.includes('oauth')) {
      if (!this.openConnector) throw new Error(`No gateway attached for ${hit.displayName}`);
      const { authorizationUrl } = await this.openConnector.startOAuth(service);
      return { action: 'oauth_redirect', authorizeUrl: authorizationUrl, message: `Redirect to ${hit.displayName} to authorize` };
    }

    if (hit.authTypes.includes('none')) {
      this.store.saveConnection({ userId, connectorId: id });
      return { action: 'api_key_saved', message: `${hit.displayName} connected (no authentication needed)` };
    }

    throw new Error(`${hit.displayName} needs an API key. Provide one to connect.`);
  }

  /**
   * Handle OAuth callback (exchange code for tokens).
   */
  async handleOAuthCallback(
    connectorId: string,
    code: string,
    state: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string; connectorId?: string; expiresAt?: number }> {
    const uid = userId || 'default';

    try {
      const { key, tokens } = await this.oauth.complete(code, state);

      // `key` is the credentialKey; map it back to the catalog id so the
      // executor finds the connection under the same id the UI reads.
      const entry = findCatalogEntry(connectorId);
      const resolvedId = entry?.credentialKey === key ? connectorId
        : MCP_CATALOG.find(c => (c.credentialKey || c.id) === key)?.id ?? connectorId;

      this.store.saveConnection({
        userId: uid,
        connectorId: resolvedId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: Math.floor((tokens.expiresAt - Date.now()) / 1000),
      });

      getLogger().info({ connectorId: resolvedId, credentialKey: key, userId: uid }, 'OAuth connection completed');
      return {
        success: true,
        connectorId: resolvedId,
        expiresAt: tokens.expiresAt,
        message: `Connected successfully. Token expires at ${new Date(tokens.expiresAt).toISOString()}`,
      };
    } catch (err) {
      getLogger().error({ connectorId, err: (err as Error).message }, 'OAuth callback failed');
      return {
        success: false,
        message: `OAuth callback failed: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Get connection status for a connector.
   */
  async getConnectorStatus(connectorId: string, userId?: string): Promise<ConnectorStatusResult> {
    const uid = userId || 'default';
    const connection = this.store.getConnection(uid, connectorId);

    if (connection?.connectionStatus === 'connected') {
      return {
        connectorId,
        isConnected: true,
        status: connection.connectionStatus,
        tokenExpiresAt: connection.tokenExpiresAt,
        lastUpdated: connection.updatedAt,
      };
    }

    // Maybe connected through the gateway (OAuth completed at the sidecar).
    const service = await this.gatewayServiceFor(connectorId);
    if (service && await this.isConnectedAnywhere(connectorId, service, uid)) {
      return { connectorId, isConnected: true, status: 'connected', lastUpdated: connection?.updatedAt };
    }

    return {
      connectorId,
      isConnected: false,
      status: connection?.connectionStatus || 'disconnected',
      tokenExpiresAt: connection?.tokenExpiresAt,
      lastUpdated: connection?.updatedAt,
    };
  }

  /**
   * Disconnect a user from a connector.
   */
  async disconnectConnector(connectorId: string, userId?: string): Promise<{ success: boolean }> {
    const uid = userId || 'default';
    const success = this.store.removeConnection(uid, connectorId);
    getLogger().info({ connectorId, userId: uid }, 'Connector disconnected');
    return { success };
  }

  /**
   * Execute a connector action.
   */
  async executeConnectorAction(
    connectorId: string,
    endpoint: string,
    method: string,
    payload: Record<string, unknown>,
    userId?: string,
  ): Promise<ToolResult> {
    const uid = userId || 'default';
    const local = await this.executor.execute(
      connectorId,
      endpoint,
      method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      payload,
      uid,
    );
    if (local.success) return local;
    // A real provider answer (even an error status) stands. Only retry via
    // the gateway when local couldn't route at all — and never for absolute
    // URLs, which the gateway proxy refuses.
    if (!this.openConnector
      || !this.isGatewayCandidateError(local.error)
      || /^https?:\/\//i.test(endpoint)) {
      return local;
    }
    try {
      const service = await this.gatewayServiceFor(connectorId);
      if (!service) return local;
      const started = Date.now();
      if (this.looksLikeGatewayAction(endpoint)) {
        const r = await this.openConnector.executeAction(
          endpoint, (payload ?? {}) as Record<string, unknown>, {});
        return {
          success: r.ok, connector: connectorId, endpoint, method,
          status: r.status, latencyMs: Date.now() - started, data: r.data, error: r.error,
        };
      }
      const r = await this.openConnector.proxy(service, endpoint, method, payload ?? {});
      return {
        success: r.ok, connector: connectorId, endpoint, method,
        status: r.status, latencyMs: Date.now() - started, data: r.data, error: r.error,
      };
    } catch (err) {
      getLogger().warn({ connectorId, err: (err as Error).message }, 'Gateway execute fallback failed — returning local result');
      return local;
    }
  }

  /**
   * Get tools relevant to a user query (for LLM function calling).
   */
  async getRelevantTools(query: string, limit?: number): Promise<ConnectorTool[]> {
    const local = this.retriever.getRelevantTools(query, { limit: limit ?? 5 });
    if (!this.openConnector) return local;
    try {
      if (!(await this.openConnector.isAvailable())) return local;
      const hits = await this.openConnector.searchActions(query, limit ?? 5);
      const seen = new Set(local.map(t => t.connectorId));
      const extra: ConnectorTool[] = [];
      for (const h of hits) {
        if (!h.service || seen.has(h.service)) continue;
        seen.add(h.service);
        extra.push({
          name: `${h.service.replace(/-/g, '_')}_execute_action`,
          description: h.description || `Execute actions on ${h.service}`,
          connectorId: h.service,
          connectorName: h.service,
          category: 'Other',
          authType: 'apiKey',
          parameters: {
            type: 'OBJECT',
            properties: {
              endpoint: { type: 'STRING', description: 'API endpoint route or gateway Action id (e.g. "service.action_name")' },
              method: { type: 'STRING', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method for the request' },
              payload: { type: 'OBJECT', description: 'JSON payload for request body (POST/PUT/PATCH) or query parameters (GET)' },
            },
            required: ['endpoint', 'method'],
          },
        });
      }
      return [...local, ...extra].slice(0, (limit ?? 5) + extra.length);
    } catch {
      return local;
    }
  }

  /**
   * Execute a multi-step workflow across connectors.
   */
  async executeWorkflow(
    actions: ConnectorAction[],
    userId?: string,
  ): Promise<AgentConnectorResult> {
    const uid = userId || 'default';
    return this.bridge.executeWorkflow(actions, uid);
  }

  /**
   * Parse an LLM function call into a ConnectorAction.
   */
  parseFunctionCall(functionName: string, args: Record<string, unknown>): ConnectorAction | null {
    return this.bridge.parseFunctionCall(functionName, args);
  }

  /**
   * Sync connector catalog from external sources.
   */
  async syncCatalog(): Promise<{ added: number; total: number }> {
    // This triggers the sync script output to be reloaded
    // In production, this would re-import ExternalCatalog.json
    const before = catalogCount();
    // Force catalog reload by re-importing
    const after = catalogCount();
    return {
      added: after - before,
      total: after,
    };
  }

  /**
   * Get system health status for connectors.
   */
  async getSystemHealth(): Promise<{
    status: string;
    connectors: { total: number; verified: number; template: number; external: number };
    oauth: { configured: number; connectors: string[] };
    database: string;
    gateway: { available: boolean; providers: number };
  }> {
    const verified = MCP_CATALOG.filter(c => c.kind === 'verified').length;
    const template = MCP_CATALOG.filter(c => c.kind === 'template').length;
    const external = MCP_CATALOG.filter(c => (c as any).kind === 'external').length;

    const devCreds = this.store.listDeveloperCredentials();
    const oauthConnectors = devCreds.filter(c => c.isConfigured).map(c => c.connectorSlug);

    let gateway = { available: false, providers: 0 };
    if (this.openConnector) {
      try {
        const available = await this.openConnector.isAvailable();
        const providers = available ? (await this.openConnector.listProviders()).length : 0;
        gateway = { available, providers };
      } catch {
        // Gateway down — health still reports local state.
      }
    }

    return {
      status: 'ok',
      connectors: {
        total: MCP_CATALOG.length,
        verified,
        template,
        external,
      },
      oauth: {
        configured: devCreds.length,
        connectors: oauthConnectors,
      },
      database: 'sqlite',
      gateway,
    };
  }

  /**
   * Save developer credentials (OAuth client ID/secret or API key) for a connector.
   */
  async saveDeveloperCredential(slug: string, clientId: string, clientSecret: string, scopes: string[] = []): Promise<{ saved: boolean }> {
    this.store.saveDeveloperCredentials(slug, clientId, clientSecret, scopes);
    return { saved: true };
  }

  /** Look up stored developer credentials for a connector slug (credentialKey). */
  getDeveloperCredentials(slug: string): DeveloperCredential | null {
    return this.store.getDeveloperCredentials(slug);
  }

  /** Persist an OAuth token set for a user (called by the OAuth flow). */
  saveOAuthTokens(opts: {
    userId: string;
    connectorId: string;
    accessToken: string;
    refreshToken?: string;
    apiKey?: string;
    expiresIn: number;
  }): UserConnection {
    return this.store.saveConnection(opts);
  }

  /** Read decrypted OAuth tokens for a user (what ToolExecutor uses per request). */
  getOAuthTokens(userId: string, connectorId: string): { accessToken?: string; refreshToken?: string; apiKey?: string } | undefined {
    return this.store.getDecryptedTokens(userId, connectorId);
  }

  /** Raw connection row — carries tokenExpiresAt for expiry checks. */
  getConnectionRow(userId: string, connectorId: string): UserConnection | null {
    return this.store.getConnection(userId, connectorId);
  }
}
