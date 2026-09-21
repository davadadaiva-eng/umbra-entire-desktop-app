import * as http from 'http';
import { McpRegistry } from './McpRegistry';
import { ExternalRegistrySync, OFFICIAL_REGISTRY_SOURCE, RegistrySource } from './ExternalRegistrySync';

function fakeServer(payload: unknown): Promise<http.Server> {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, () => resolve(server));
  });
}

const TEST_SOURCE: RegistrySource = {
  name: 'test',
  url: '', // patched in before each run
  extract: json => json.servers,
  map: (e: any) => ({
    id: `ext-${e.qualifiedName}`,
    name: e.displayName,
    baseUrl: e.remote ? e.homepage : '',
    authType: 'none',
    credentialKey: 'external',
  }),
};

describe('ExternalRegistrySync', () => {
  it('registers connectors discovered from a registry source', async () => {
    const server = await fakeServer({
      servers: [
        { qualifiedName: 'brave', displayName: 'Brave Search', remote: true, homepage: 'https://brave.com' },
        { qualifiedName: 'postgres', displayName: 'PostgreSQL', remote: false },
      ],
    });
    const port = (server.address() as any).port;
    const registry = new McpRegistry();
    const sync = new ExternalRegistrySync(registry, { sources: [{ ...TEST_SOURCE, url: `http://127.0.0.1:${port}/servers` }] });

    try {
      const result = await sync.sync();
      expect(result.registered).toBe(2);
      expect(registry.resolve('ext-brave', 'invoke')?.endpoint).toBe('https://brave.com');
      expect(registry.resolve('ext-postgres', 'invoke')).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('maps the official MCP registry entries to remote connectors (1000+ servers)', async () => {
    const payload = {
      servers: [
        {
          server: {
            name: 'acme/mcp',
            title: 'Acme Tools',
            description: 'A published MCP server.',
            version: '1.0.0',
            remotes: [
              { type: 'sse', url: 'https://sse.example.com' },
              { type: 'streamable-http', url: 'https://api.example.com/mcp' },
            ],
          },
        },
        {
          server: { name: 'alpha/beta', title: 'Alpha Beta', remotes: [] },
        },
      ],
    };
    const server = await fakeServer(payload);
    const port = (server.address() as any).port;
    const registry = new McpRegistry();
    const sync = new ExternalRegistrySync(registry, {
      sources: [{ ...OFFICIAL_REGISTRY_SOURCE, url: `http://127.0.0.1:${port}/servers` }],
      dedupe: true,
    });
    try {
      const result = await sync.sync();
      expect(result.registered).toBe(2);
      // streamable-http remote is preferred; id is slugged from server name.
      const acme = registry.resolve('mcp-acme-mcp', 'invoke');
      expect(acme?.endpoint).toBe('https://api.example.com/mcp');
      expect(registry.resolve('mcp-alpha-beta', 'invoke')).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('tolerates a failing source and reports the error', async () => {
    const server = await fakeServer({ servers: [] });
    const port = (server.address() as any).port;
    const registry = new McpRegistry();
    const sync = new ExternalRegistrySync(registry, {
      sources: [
        { name: 'down', url: 'http://127.0.0.1:0/servers', extract: j => j.servers, map: () => ({ id: 'x' }) },
        { ...TEST_SOURCE, url: `http://127.0.0.1:${port}/servers` },
      ],
    });
    try {
      const result = await sync.sync();
      expect(result.registered).toBe(0);
      expect(result.errors.length).toBe(1);
    } finally {
      server.close();
    }
  });

  it('dedupes against already-registered connectors', async () => {
    const server = await fakeServer({ servers: [{ qualifiedName: 'gh', displayName: 'GitHub' }] });
    const port = (server.address() as any).port;
    const registry = new McpRegistry();
    registry.register('ext-gh', 'invoke');
    const sync = new ExternalRegistrySync(registry, {
      dedupe: true,
      sources: [{ ...TEST_SOURCE, url: `http://127.0.0.1:${port}/servers` }],
    });
    try {
      const result = await sync.sync();
      expect(result.registered).toBe(0);
    } finally {
      server.close();
    }
  });
});