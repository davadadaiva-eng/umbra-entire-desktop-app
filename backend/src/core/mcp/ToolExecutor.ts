/**
 * ToolExecutor — universal REST execution engine for connector actions.
 *
 * Retrieves stored credentials from ConnectorStore, auto-refreshes
 * expired OAuth tokens, and executes HTTP requests against any
 * connector's API using the OpenAPI spec or endpoint conventions.
 *
 * Uses HttpBridge (curl.exe) to bypass Node v24 TLS stack issues.
 */

import { HttpBridge } from '../agent/HttpBridge';
import { ConnectorStore } from './ConnectorStore';
import { MCP_CATALOG, findCatalogEntry } from './McpCatalog';
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
}

export interface ExecuteOptions {
  /** Request timeout in milliseconds (default: 30_000). */
  timeoutMs?: number;
  /** Additional headers to send. */
  headers?: Record<string, string>;
  /** Skip token refresh attempt (useful for retry loops). */
  skipRefresh?: boolean;
}

// ── ToolExecutor ────────────────────────────────────────────────────

export class ToolExecutor {
  private store: ConnectorStore;

  constructor(store: ConnectorStore) {
    this.store = store;
  }

  /**
   * Execute an action against a connector.
   *
   * @param connectorId - The connector slug/id (e.g. 'gmail', 'spotify')
   * @param endpoint - API endpoint path (e.g. '/v1/me/player', '/messages')
   * @param method - HTTP method (GET, POST, PUT, DELETE, PATCH)
   * @param payload - Request body or query parameters
   * @param userId - User ID for credential lookup
   * @returns ToolResult with status, data, and latency
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
    const timeoutMs = options.timeoutMs ?? 30_000;

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
    if (!tokens || (!tokens.accessToken && !tokens.apiKey)) {
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
    let accessToken = tokens.accessToken;
    if (connector.authType === 'oauth' && tokens.refreshToken && !options.skipRefresh) {
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

    // 4. Build request
    const baseUrl = connector.baseUrl || this.guessBaseUrl(connectorId);
    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };

    // Attach auth
    if (connector.authType === 'oauth' || connector.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${accessToken}`;
    } else if (connector.authType === 'apiKey') {
      const headerName = connector.apiKeyHeader || 'X-API-Key';
      headers[headerName] = tokens.apiKey || accessToken || '';
    }

    // 5. Execute request
    try {
      const result = await HttpBridge.request({
        url,
        method,
        headers,
        body: method === 'GET' ? undefined : payload,
        params: method === 'GET' ? (payload as Record<string, string>) : undefined,
        timeoutMs,
      });

      getLogger().info({
        connectorId,
        endpoint,
        method,
        status: result.status,
        latencyMs: Date.now() - started,
      }, 'Connector action executed');

      return {
        success: true,
        connector: connectorId,
        endpoint,
        method,
        status: result.status,
        latencyMs: Date.now() - started,
        data: result.data,
      };
    } catch (err: any) {
      getLogger().error({
        connectorId,
        endpoint,
        method,
        err: err.message,
      }, 'Connector action failed');

      return {
        success: false,
        connector: connectorId,
        endpoint,
        method,
        status: 0,
        latencyMs: Date.now() - started,
        data: null,
        error: err.message || 'Request failed',
      };
    }
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
    const devCreds = this.store.getDeveloperCredentials(credKey);

    if (!devCreds) {
      throw new Error(`No developer credentials configured for ${credKey}. Add them at /admin/developer-apps`);
    }

    // Known token endpoints
    const tokenEndpoints: Record<string, string> = {
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

    const tokenUrl = tokenEndpoints[credKey] || `https://oauth.${credKey}.com/token`;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: devCreds.clientId,
      client_secret: devCreds.clientSecret,
    });

    const response = await HttpBridge.post(tokenUrl, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }, 10000);

    const tokens = response.data;
    if (!tokens.access_token) {
      throw new Error('Token refresh did not return access_token');
    }

    // Save the new tokens
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
   * Guess a base URL for well-known connectors.
   */
  private guessBaseUrl(connectorId: string): string {
    const knownUrls: Record<string, string> = {
      gmail: 'https://gmail.googleapis.com',
      'google-calendar': 'https://www.googleapis.com',
      'google-drive': 'https://www.googleapis.com',
      'google-docs': 'https://docs.googleapis.com',
      'google-sheets': 'https://sheets.googleapis.com',
      spotify: 'https://api.spotify.com',
      discord: 'https://discord.com/api',
      slack: 'https://slack.com/api',
      github: 'https://api.github.com',
      twitter: 'https://api.twitter.com',
      stripe: 'https://api.stripe.com',
      shopify: 'https://{shop}.myshopify.com/admin/api/2024-01',
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

    return knownUrls[connectorId] || `https://api.${connectorId}.com`;
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
