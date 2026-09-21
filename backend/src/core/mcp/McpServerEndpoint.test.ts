import { McpRegistry } from './McpRegistry';
import { McpRouter } from './McpRouter';
import { McpServerEndpoint } from './McpServerEndpoint';

function makeEndpoint() {
  const registry = new McpRegistry();
  registry.register('communication-slack', 'invoke', {
    endpoint: 'https://slack.example.invalid/rpc',
    credentialService: 'slack',
    authType: 'bearer',
  });
  registry.register('stripe', 'invoke', {
    endpoint: 'https://stripe.example.invalid/rpc',
    credentialService: 'stripe',
    authType: 'bearer',
  });
  registry.register('subagent', 'execute', { transport: 'native' });
  const router = new McpRouter(registry, {
    connector: undefined,
    nativeHandlers: new Map([
      ['subagent.execute', async (input: Record<string, unknown>) => `ANSWER: ${String(input.prompt || '')}`],
    ]),
  });
  return new McpServerEndpoint(registry, router);
}

describe('McpServerEndpoint', () => {
  it('answers initialize with protocol + capabilities', async () => {
    const endpoint = makeEndpoint();
    const res = await endpoint.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(res).not.toBeNull();
    expect((res!.result as any).protocolVersion).toBe('2025-03-26');
    expect((res!.result as any).capabilities.tools).toEqual({});
    expect((res!.result as any).serverInfo.name).toBe('umbra');
  });

  it('lists every registered connector tool', async () => {
    const endpoint = makeEndpoint();
    const res = await endpoint.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res).not.toBeNull();
    const tools = (res!.result as any).tools as Array<{ name: string }>;
    expect(tools.map(t => t.name)).toEqual(['communication-slack.invoke', 'stripe.invoke', 'subagent.execute']);
  });

  it('dispatches tools/call through the router', async () => {
    const endpoint = makeEndpoint();
    const res = await endpoint.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'subagent.execute', arguments: { prompt: 'summarize' } },
    });
    expect(res).not.toBeNull();
    expect((res!.result as any).content[0].text).toBe('ANSWER: summarize');
    expect((res!.result as any).isError).toBe(false);
  });

  it('marks a failed call as isError with text', async () => {
    const endpoint = makeEndpoint();
    const res = await endpoint.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'communication-slack.invoke', arguments: {} },
    });
    expect(res).not.toBeNull();
    expect((res!.result as any).isError).toBe(true);
    expect((res!.result as any).content[0].text).toContain('Error');
  });

  it('returns null for notifications', async () => {
    const endpoint = makeEndpoint();
    const res = await endpoint.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });

  it('returns a JSON-RPC error for unknown methods', async () => {
    const endpoint = makeEndpoint();
    const res = await endpoint.handle({ jsonrpc: '2.0', id: 5, method: 'bogus/method' });
    expect(res).not.toBeNull();
    expect((res!.error as any).code).toBe(-32601);
  });
});
