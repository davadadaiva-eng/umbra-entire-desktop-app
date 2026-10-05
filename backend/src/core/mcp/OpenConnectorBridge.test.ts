import { OpenConnectorBridge } from './OpenConnectorBridge';

function mockFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (url: any, _init: any) => {
    const u = String(url);
    for (const [k, v] of Object.entries(routes)) {
      if (u.includes(k)) {
        return new Response(JSON.stringify(v.body), { status: v.status });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as typeof fetch;
}

describe('OpenConnectorBridge', () => {
  test('health() true on 200', async () => {
    const b = new OpenConnectorBridge({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: mockFetch({ '/v1/health': { status: 200, body: { success: true } } }),
    });
    await expect(b.health()).resolves.toMatchObject({ ok: true });
  });

  test('health() false when down', async () => {
    const b = new OpenConnectorBridge({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch,
    });
    await expect(b.health()).resolves.toMatchObject({ ok: false, status: 0 });
  });

  test('executeAction() maps success + executionId', async () => {
    const b = new OpenConnectorBridge({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: mockFetch({
        '/v1/actions/github.get_current_user': {
          status: 200,
          body: { success: true, data: { login: 'octocat' }, meta: { executionId: 'ex-1' } },
        },
      }),
    });
    const r = await b.executeAction('github.get_current_user', {});
    expect(r.ok).toBe(true);
    expect(r.executionId).toBe('ex-1');
  });

  test('executeAction() maps provider error without throwing', async () => {
    const b = new OpenConnectorBridge({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: mockFetch({
        '/v1/actions/github.get_current_user': {
          status: 403,
          body: { success: false, errorCode: 'authorization_failed', message: 'reconnect' },
        },
      }),
    });
    const r = await b.executeAction('github.get_current_user', {});
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('authorization_failed');
  });

  test('sends alias + idempotency headers', async () => {
    let seen: Record<string, string> = {};
    const f = (async (url: any, init: any) => {
      seen = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    }) as typeof fetch;
    const b = new OpenConnectorBridge({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: f });
    await b.executeAction('github.get_current_user', {}, { connectionName: 'work', idempotencyKey: 'k-1' });
    expect(seen['x-oo-connector-alias']).toBe('work');
    expect(seen['Idempotency-Key']).toBe('k-1');
  });

  test('startOAuth() returns the provider authorize URL', async () => {
    const b = new OpenConnectorBridge({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: mockFetch({
        '/api/oauth/authorizations': {
          status: 200,
          body: { success: true, data: { authorizationUrl: 'https://provider.example/auth?x=1' } },
        },
      }),
    });
    await expect(b.startOAuth('hubspot')).resolves.toMatchObject({
      authorizationUrl: 'https://provider.example/auth?x=1',
    });
  });

  test('startOAuth() failure names the provider, never the gateway', async () => {
    const b = new OpenConnectorBridge({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: mockFetch({
        '/api/oauth/authorizations': { status: 500, body: { success: false } },
      }),
    });
    const err: unknown = await b.startOAuth('hubspot').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/hubspot/i);
    expect(msg).not.toMatch(/open-?connector/i);
    expect(msg).not.toMatch(/gateway/i);
  });

  test('listProviders() normalizes object-shaped categories (live sidecar shape)', async () => {
    const b = new OpenConnectorBridge({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: mockFetch({
        '/v1/providers': {
          status: 200,
          body: {
            success: true,
            data: [
              {
                service: 'gmail',
                displayName: 'Gmail',
                categories: [{ id: 'Productivity', displayName: 'Productivity' }],
                authTypes: ['oauth2'],
              },
            ],
          },
        },
      }),
    });
    const list = await b.listProviders();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ service: 'gmail', categories: ['Productivity'] });
    expect(list[0].authTypes).toContain('oauth');
  });
});
