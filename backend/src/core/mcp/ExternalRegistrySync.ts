/**
 * External Registry Sync — discovers MCP connectors from public registries,
 * validates them, and registers connectable entries into the local MCP
 * registry. Secrets never leave the machine: auth tokens are resolved
 * lazily from the CredentialVault at call time.
 */

import { McpRegistry } from './McpRegistry';
import { McpConnectorConfig } from '../../types';
import { getLogger } from '../Logger';
import { HttpBridge } from '../agent/HttpBridge';

export interface RegistrySource {
  /** Human label for logs. */
  name: string;
  url: string;
  /** Response accessor: how to pull the list from a parsed JSON body. */
  extract: (json: any) => any[];
  /** Field accessors mapping a registry entry → catalog shape. */
  map: (entry: any, index: number) => Partial<McpConnectorConfig> & { description?: string };
  /** HTTP headers for the request. */
  headers?: Record<string, string>;
}

export interface SyncOptions {
  sources?: RegistrySource[];
  /** Per-source fetch timeout. */
  timeoutMs?: number;
  /** Max connectors to accept per source (0 = unlimited). */
  maxPerSource?: number;
  /** Skip already-registered ids. */
  dedupe?: boolean;
  /** Optional listener for progress. */
  onProgress?: (source: string, count: number, total: number) => void;
}

export const SMITHERY_SOURCE: RegistrySource = {
  name: 'smithery',
  url: 'https://api.smithery.ai/servers',
  extract: json => json?.servers ?? [],
  map: (e: any) => ({
    id: `smithery-${e.qualifiedName || e.id || ''}`.replace(/[^a-zA-Z0-9-_]/g, '-'),
    name: e.displayName || e.qualifiedName || 'Unknown',
    category: 'External Registry',
    baseUrl: e.remote ? e.homepage || '' : '',
    authType: (e.verified ? 'apiKey' : 'none') as McpConnectorConfig['authType'],
    apiKeyHeader: 'Authorization',
    credentialKey: 'smithery',
    description: typeof e.description === 'string' ? e.description.slice(0, 160) : '',
  }),
};

/**
 * The official MCP registry (registry.modelcontextprotocol.io) — thousands of
 * published streamable-HTTP servers. Entries map 1:1 to remote connectors:
 * registering one makes it callable through the same MCP router, so a single
 * sync turns the catalog into 1000+ working connectors.
 */
export const OFFICIAL_REGISTRY_SOURCE: RegistrySource = {
  name: 'mcp-registry',
  url: 'https://registry.modelcontextprotocol.io/v0/servers',
  extract: json => json?.servers ?? [],
  map: (server: any) => {
    const def = server?.server ?? {};
    const remotes: Array<{ type?: string; url?: string }> = Array.isArray(def.remotes) ? def.remotes : [];
    const remote = remotes.find(r => r?.type === 'streamable-http') ?? remotes[0];
    return {
      id: `mcp-${def.name || 'server'}`.replace(/[^a-zA-Z0-9-_]/g, '-'),
      name: def.title || def.name || 'Unknown',
      category: 'Official MCP Registry',
      baseUrl: remote?.url || '',
      authType: 'none' as McpConnectorConfig['authType'],
      credentialKey: 'mcp-registry',
      description: typeof def.description === 'string' ? def.description.slice(0, 160) : '',
    };
  },
};

/** All bundled registry sources, in priority order. */
export const DEFAULT_SOURCES: RegistrySource[] = [SMITHERY_SOURCE, OFFICIAL_REGISTRY_SOURCE];

export class ExternalRegistrySync {
  private registry: McpRegistry;
  private options: SyncOptions;

  constructor(registry: McpRegistry, options: SyncOptions = {}) {
    this.registry = registry;
    this.options = options;
  }

  /** Register a connector directly (local API path stays separate). */
  registerLocal(connector: McpConnectorConfig): void {
    this.registry.register(connector.id, 'invoke', {
      endpoint: connector.baseUrl || undefined,
      credentialService: connector.credentialKey || connector.name,
      apiKeyHeader: connector.apiKeyHeader,
      authType: connector.authType,
    });
  }

  /** Pull connectors from all configured sources and register them. */
  async sync(callOptions: SyncOptions = {}): Promise<{ registered: number; sources: string[]; errors: string[] }> {
    const opts = { ...this.options, ...callOptions };
    const sources = opts.sources ?? [SMITHERY_SOURCE];
    const errors: string[] = [];
    let registered = 0;

    for (const source of sources) {
      try {
        const count = await this.syncSource(source, opts);
        registered += count;
      } catch (err) {
        errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
        getLogger().warn({ source: source.name, err: errors[errors.length - 1] }, 'Registry sync failed for source');
      }
    }
    return { registered, sources: sources.map(s => s.name), errors };
  }

  private async syncSource(source: RegistrySource, opts: SyncOptions): Promise<number> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    let loaded = 0;
    try {
      const result = await HttpBridge.get(source.url, undefined, { 'accept': 'application/json', 'user-agent': 'umbra-os/registry-sync', ...source.headers }, timeoutMs);
      if (result.status < 200 || result.status >= 300) throw new Error(`HTTP ${result.status}`);

      let payload: any = result.data;
      if (!payload) throw new Error(`Non-JSON response from ${source.url}`);
      const raw = source.extract(payload);
      if (!Array.isArray(raw)) throw new Error('Extractor did not return an array');

      const max = opts.maxPerSource && opts.maxPerSource > 0 ? opts.maxPerSource : raw.length;
      for (let i = 0; i < Math.min(max, raw.length); i++) {
        const mapped = source.map(raw[i], i);
        if (!mapped.id) continue;
        if (opts.dedupe && this.registry.resolve(mapped.id, 'invoke')) continue;
        this.registry.register(mapped.id, 'invoke', {
          endpoint: mapped.baseUrl || undefined,
          credentialService: mapped.credentialKey,
          apiKeyHeader: mapped.apiKeyHeader,
          authType: mapped.authType,
        });
        loaded++;
      }
      opts.onProgress?.(source.name, loaded, raw.length);
      getLogger().info({ source: source.name, loaded }, 'Registry sync complete for source');
      return loaded;
    } finally {
      // no-op: HttpBridge handles its own timeout
    }
  }
}