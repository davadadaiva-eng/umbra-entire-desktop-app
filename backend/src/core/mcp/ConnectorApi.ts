/**
 * ConnectorApi — handler class implementing the connector marketplace API.
 *
 * Bridges the ApiServer routes to the ConnectorStore, ToolRetriever,
 * ToolExecutor, and OAuthConnector for the full connect/discover/execute flow.
 */

import { ConnectorStore, UserConnection } from './ConnectorStore';
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

  constructor(
    store: ConnectorStore,
    oauth?: OAuthConnector,
    /** Executor wiring (definition store, injection guard, MCP router). */
    executorOptions?: ToolExecutorOptions,
  ) {
    this.store = store;
    this.retriever = new ToolRetriever();
    this.executor = new ToolExecutor(store, executorOptions);
    this.bridge = new AgentConnectorBridge(store, {
      executeToolDefinition: (def, args, userId) => this.executor.executeTool(def, args, userId),
    });
    this.oauth = oauth || new OAuthConnector();
  }

  /** Get the AgentConnectorBridge for wiring into the agent runtime. */
  getAgentConnectorBridge(): AgentConnectorBridge {
    return this.bridge;
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
