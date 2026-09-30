/**
 * ConnectorApi — handler class implementing the connector marketplace API.
 *
 * Bridges the ApiServer routes to the ConnectorStore, ToolRetriever,
 * ToolExecutor, and OAuthConnector for the full connect/discover/execute flow.
 */

import { ConnectorStore, UserConnection } from './ConnectorStore';
import { ToolDefinition } from './ToolDefinition';
import { HttpBridge } from '../agent/HttpBridge';
import { ToolRetriever, ConnectorTool } from './ToolRetriever';
import { ToolExecutor, ToolResult, ToolExecutorOptions } from './ToolExecutor';
import { AgentConnectorBridge, ConnectorAction, AgentConnectorResult } from '../agent/AgentConnectorBridge';
import { OAuthConnector, OAuthClient } from './OAuthConnector';
import { MCP_CATALOG, findCatalogEntry, catalogByCategory, catalogCount, McpCatalogEntry } from './McpCatalog';
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
  /** Definition store for the schema browser (optional — tool framework). */
  private toolSchemas?: {
    listAll(): ToolDefinition[];
    getForConnector(connectorId: string): ToolDefinition[];
    count(): number;
    deleteForConnector(connectorId: string): number;
    ingestOpenApi(connectorId: string, spec: unknown, opts?: Record<string, unknown>): number;
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
    },
  ) {
    this.store = store;
    this.retriever = new ToolRetriever();
    this.executor = new ToolExecutor(store, executorOptions);
    this.bridge = new AgentConnectorBridge(store, {
      executeToolDefinition: (def, args, userId) => this.executor.executeTool(def, args, userId),
    });
    this.oauth = oauth || new OAuthConnector();
    this.toolSchemas = toolSchemas;
  }

  /** Get the AgentConnectorBridge for wiring into the agent runtime. */
  getAgentConnectorBridge(): AgentConnectorBridge {
    return this.bridge;
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

    // Defaults from the catalog entry when this connector is a known one.
    const entry = findCatalogEntry(connectorId);
    const authMap: Record<string, ToolDefinition['auth_type']> = { none: 'none', apiKey: 'apiKey', bearer: 'bearer', oauth: 'oauth' };
    const authType = authMap[String(opts.authType ?? entry?.authType ?? 'none')] ?? undefined;
    const baseUrl = opts.baseUrl ?? entry?.baseUrl ?? undefined;
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

  /**
   * Get a single connector by ID.
   */
  async getConnector(id: string, userId?: string): Promise<ConnectorDetailResult> {
    const connector = findCatalogEntry(id);
    if (!connector) {
      throw new Error(`Connector "${id}" not found`);
    }

    let isConnected = false;
    let connection: UserConnection | undefined;

    if (userId) {
      connection = this.store.getConnection(userId, id) || undefined;
      isConnected = connection?.connectionStatus === 'connected';
    }

    return { connector, isConnected, connection };
  }

  /**
   * Get all categories with counts.
   */
  async getConnectorCategories(): Promise<{ category: string; count: number }[]> {
    return this.retriever.getCategories();
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
      throw new Error(`Connector "${id}" not found`);
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

      const redirectUri = opts.redirectUri || `http://localhost:8787/api/connectors/${id}/callback`;
      const { authorizeUrl, state } = this.oauth.begin(id, client, redirectUri);

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
   * Handle OAuth callback (exchange code for tokens).
   */
  async handleOAuthCallback(
    connectorId: string,
    code: string,
    state: string,
    userId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const uid = userId || 'default';

    try {
      const { key, tokens } = await this.oauth.complete(code, state);

      this.store.saveConnection({
        userId: uid,
        connectorId: key,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: Math.floor((tokens.expiresAt - Date.now()) / 1000),
      });

      getLogger().info({ connectorId: key, userId: uid }, 'OAuth connection completed');
      return {
        success: true,
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

    return {
      connectorId,
      isConnected: connection?.connectionStatus === 'connected',
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
    return this.executor.execute(
      connectorId,
      endpoint,
      method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      payload,
      uid,
    );
  }

  /**
   * Get tools relevant to a user query (for LLM function calling).
   */
  async getRelevantTools(query: string, limit?: number): Promise<ConnectorTool[]> {
    return this.retriever.getRelevantTools(query, { limit: limit ?? 5 });
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
  }> {
    const verified = MCP_CATALOG.filter(c => c.kind === 'verified').length;
    const template = MCP_CATALOG.filter(c => c.kind === 'template').length;
    const external = MCP_CATALOG.filter(c => (c as any).kind === 'external').length;

    const devCreds = this.store.listDeveloperCredentials();
    const oauthConnectors = devCreds.filter(c => c.isConfigured).map(c => c.connectorSlug);

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
    };
  }

  /**
   * Save developer credentials (OAuth client ID/secret or API key) for a connector.
   */
  async saveDeveloperCredential(slug: string, clientId: string, clientSecret: string, scopes: string[] = []): Promise<{ saved: boolean }> {
    this.store.saveDeveloperCredentials(slug, clientId, clientSecret, scopes);
    return { saved: true };
  }
}
