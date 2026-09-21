import * as os from 'os';
import * as path from 'path';
import { McpRegistry } from './McpRegistry';
import { McpRouter } from './McpRouter';
import { McpHttpConnector } from './McpHttpConnector';
import { CredentialVault } from '../vault/CredentialVault';

const dir = path.join(os.tmpdir(), `umbra-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const freshDir = () => path.join(dir, Math.random().toString(36).slice(2, 10));

describe('MCP Registry + Router', () => {
  it('registers and resolves tool bindings', () => {
    const registry = new McpRegistry();
    registry.register('web-research', 'search', { endpoint: 'https://example.invalid/rpc' });
    const binding = registry.resolve('web-research', 'search');
    expect(binding?.transport).toBe('http');
    expect(binding?.key).toBe('web-research.search');
  });

  it('routes prompt-based tools without an endpoint', async () => {
    const registry = new McpRegistry();
    registry.register('notes', 'capture');
    const router = new McpRouter(registry);
    const result = await router.call('notes', 'capture', { text: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.transport).toBe('prompt');
  });

  it('routes native tools to registered handlers', async () => {
    const registry = new McpRegistry();
    registry.register('math', 'double', { transport: 'native' });
    const router = new McpRouter(registry, {
      nativeHandlers: new Map([['math.double', input => (Number(input.value) || 0) * 2]]),
    });
    const result = await router.call('math', 'double', { value: 21 });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(42);
  });

  it('dispatches native tools to registered handlers and surfaces failures', async () => {
    const registry = new McpRegistry();
    registry.register('subagent', 'execute', { transport: 'native' });
    const router = new McpRouter(registry, {
      nativeHandlers: new Map([
        ['subagent.execute', async (input: Record<string, unknown>) => {
          const prompt = String(input.prompt || '');
          if (!prompt) throw new Error('subagent.execute needs input.prompt');
          if (String(input.prompt).includes('fail')) throw new Error('Agent task failed: boom');
          return `RESULT: ${prompt}`;
        }],
      ]),
    });

    const ok = await router.call('subagent', 'execute', { prompt: 'Summarize this repo', model: 'reasoning-model' });
    expect(ok.ok).toBe(true);
    expect(ok.output).toBe('RESULT: Summarize this repo');
    expect(ok.transport).toBe('native');

    const missing = await router.call('subagent', 'execute', {});
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/needs input.prompt/);

    const failed = await router.call('subagent', 'execute', { prompt: 'make it fail' });
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/boom/);
  });

  it('returns an error result for unknown tools', async () => {
    const router = new McpRouter(new McpRegistry());
    const result = await router.call('nope', 'missing', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });
});

describe('McpHttpConnector + CredentialVault', () => {
  it('speaks MCP JSON-RPC tools/call and returns the text content', async () => {
    const vault = new CredentialVault({ dataDir: freshDir(), hwid: 'test-hwid' });
    vault.unlock();
    vault.set({ service: 'telnyx', username: 'api-key', secret: 's3cret' });

    const requests: any[] = [];
    const server = require('http').createServer((req: any, res: any) => {
      let body = '';
      req.on('data', (c: any) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push({ method: parsed.method, auth: req.headers['authorization'], mcpVersion: req.headers['mcp-protocol-version'], name: parsed.params?.name, args: parsed.params?.arguments });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: { content: [{ type: 'text', text: 'SMS queued to +1555' }] },
        }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const registry = new McpRegistry();
      registry.register('telco', 'send-sms', {
        endpoint: `http://127.0.0.1:${port}/rpc`,
        credentialService: 'telnyx',
        apiKeyHeader: 'Authorization',
        authType: 'apiKey',
      });
      const connector = new McpHttpConnector({ vault });
      const router = new McpRouter(registry, { connector });
      const result = await router.call('telco', 'send-sms', { to: '+1555', text: 'hi' });
      expect(result.ok).toBe(true);
      expect(result.output).toBe('SMS queued to +1555');
      expect(requests[0].method).toBe('tools/call');
      expect(requests[0].name).toBe('send-sms');
      expect(requests[0].args.to).toBe('+1555');
      expect(requests[0].auth).toBe('Bearer s3cret');
      expect(requests[0].mcpVersion).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('parses streamable-HTTP SSE responses (event: message / data: {...})', async () => {
    const server = require('http').createServer((req: any, res: any) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'event: message\r\n' +
          'data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"answer from SSE"}]}}\r\n\r\n',
        );
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const registry = new McpRegistry();
      registry.register('deepwiki', 'ask_question', { endpoint: `http://127.0.0.1:${port}/` });
      const connector = new McpHttpConnector({ vault: undefined });
      const router = new McpRouter(registry, { connector });
      const result = await router.call('deepwiki', 'ask_question', {});
      expect(result.ok).toBe(true);
      expect(result.output).toBe('answer from SSE');
    } finally {
      server.close();
    }
  });

  it('injects custom apiKey headers verbatim', async () => {
    const vault = new CredentialVault({ dataDir: freshDir(), hwid: 'h2' });
    vault.unlock();
    vault.set({ service: 'weather', username: 'api-key', secret: 'wx-123' });

    const seen: any = {};
    const server = require('http').createServer((req: any, res: any) => {
      let body = '';
      req.on('data', (c: any) => (body += c));
      req.on('end', () => {
        seen.key = req.headers['x-api-key'];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'sunny' }] } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const registry = new McpRegistry();
      registry.register('weather', 'current', {
        endpoint: `http://127.0.0.1:${port}/`,
        credentialService: 'weather',
        apiKeyHeader: 'X-API-Key',
        authType: 'apiKey',
      });
      const connector = new McpHttpConnector({ vault });
      const router = new McpRouter(registry, { connector });
      const result = await router.call('weather', 'current', { city: 'rome' });
      expect(result.ok).toBe(true);
      expect(result.output).toBe('sunny');
      expect(seen.key).toBe('wx-123');
    } finally {
      server.close();
    }
  });

  it('performs the initialize handshake when the server demands it', async () => {
    const calls: string[] = [];
    const server = require('http').createServer((req: any, res: any) => {
      let body = '';
      req.on('data', (c: any) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        calls.push(parsed.method);
        if (parsed.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
        } else if (calls.filter(m => m === 'tools/call').length === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32002, message: 'Server not initialized' } }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: 'ready' }] } }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const registry = new McpRegistry();
      registry.register('meta', 'ping', { endpoint: `http://127.0.0.1:${port}/` });
      const connector = new McpHttpConnector({ vault: undefined });
      const router = new McpRouter(registry, { connector });
      const result = await router.call('meta', 'ping', {});
      expect(result.ok).toBe(true);
      expect(result.output).toBe('ready');
      expect(calls.filter(m => m === 'initialize').length).toBe(1);
      expect(calls.filter(m => m === 'tools/call').length).toBe(2);
    } finally {
      server.close();
    }
  });

  it('surfaces MCP JSON-RPC errors as failures', async () => {
    const server = require('http').createServer((req: any, res: any) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const registry = new McpRegistry();
      registry.register('meta', 'ping', { endpoint: `http://127.0.0.1:${port}/` });
      const connector = new McpHttpConnector({ vault: undefined });
      const router = new McpRouter(registry, { connector });
      const result = await router.call('meta', 'ping', {});
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Method not found/);
    } finally {
      server.close();
    }
  });

  it('calls without credentials when none are needed', async () => {
    const vault = new CredentialVault({ dataDir: freshDir(), hwid: 'h' });
    vault.unlock();
    const registry = new McpRegistry();
    registry.register('meta', 'ping', { endpoint: 'https://example.invalid/ping' });
    const connector = new McpHttpConnector({ vault });
    const router = new McpRouter(registry, { connector });
    const result = await router.call('meta', 'ping', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500|fetch|abort|ENOTFOUND|EAI_AGAIN|returned|resolve|curl/i);
  });
});

