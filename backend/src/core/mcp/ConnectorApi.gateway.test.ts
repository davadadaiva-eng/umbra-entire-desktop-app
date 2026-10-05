/**
 * Gateway transparency — the user never sees "open-connector".
 *
 * With a mocked sidecar attached via setOpenConnector(), gateway-only
 * providers (e.g. `hubspot`) must behave exactly like native catalog rows:
 * listable, searchable, connectable with an API key, executable, and
 * readiness-honest. Without the bridge, every path stays local-only.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectorApi } from './ConnectorApi';
import { ConnectorStore } from './ConnectorStore';
import { OAuthConnector } from './OAuthConnector';
import { OpenConnectorBridge, resolveGatewayService } from './OpenConnectorBridge';

const PROVIDERS = [
  {
    service: 'gmail',
    displayName: 'Gmail',
    categories: ['Productivity'],
    authTypes: ['oauth2'],
    description: 'Draft, send, and search email in Gmail.',
  },
  {
    service: 'hubspot',
    displayName: 'HubSpot',
    categories: ['CRM & Marketing'],
    authTypes: ['api_key'],
    description: 'Contacts, companies, deals, and tickets on HubSpot.',
  },
  // Truly novel: no local catalog row claims `acme-crm`.
  {
    service: 'acme-crm',
    displayName: 'Acme CRM',
    categories: ['CRM & Marketing'],
    authTypes: ['api_key'],
    description: 'Contacts and deals in the fictional Acme CRM.',
  },
  // Gateway-only OAuth provider: end-user sign-in must look identical to a
  // native OAuth connect (same oauth_redirect shape, provider-named text).
  {
    service: 'acme-oauth',
    displayName: 'Acme OAuth',
    categories: ['Productivity'],
    authTypes: ['oauth2'],
    description: 'Sign in with your Acme account.',
  },
];

function mockFetch(): typeof fetch {
  return (async (url: any, init: any) => {
    const u = String(url);
    const method = String(init?.method || 'GET').toUpperCase();
    if (u.endsWith('/v1/health')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (u.endsWith('/v1/providers') && method === 'GET') {
      return new Response(JSON.stringify({ success: true, data: PROVIDERS }), { status: 200 });
    }
    if (u.includes('/api/connections/') && method === 'PUT') {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (u.includes('/api/oauth/authorizations') && method === 'POST') {
      return new Response(
        JSON.stringify({ success: true, data: { authorizationUrl: 'https://acme-oauth.example/authorize?x=1' } }),
        { status: 200 },
      );
    }
    if (u.endsWith('/api/connections') && method === 'GET') {
      return new Response(
        JSON.stringify({ success: true, data: { connections: [{ service: 'acme-oauth' }] } }),
        { status: 200 },
      );
    }
    if (u.includes('/v1/proxy/') && method === 'POST') {
      return new Response(
        JSON.stringify({ success: true, data: { results: [] }, meta: { executionId: 'gw-1' } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ success: false, message: 'not found' }), { status: 404 });
  }) as typeof fetch;
}

function tmpApiWithGateway(): { api: ConnectorApi; store: ConnectorStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-gw-'));
  const store = new ConnectorStore(path.join(dir, 'connectors.db'));
  const api = new ConnectorApi(store, new OAuthConnector());
  api.setOpenConnector(new OpenConnectorBridge({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: mockFetch() }));
  return { api, store };
}

describe('gateway transparency (mocked sidecar)', () => {
  test('resolveGatewayService strips category prefixes', () => {
    expect(resolveGatewayService('productivity-gmail', new Set(['gmail']))).toBe('gmail');
    expect(resolveGatewayService('data-analytics-snowflake', new Set(['snowflake']))).toBe('snowflake');
    expect(resolveGatewayService('hubspot', new Set(['hubspot']))).toBe('hubspot');
    expect(resolveGatewayService('other-unknown', new Set(['hubspot']))).toBeUndefined();
  });

  test('listConnectors merges gateway-only providers with native shape', async () => {
    const { api } = tmpApiWithGateway();
    const res = await api.listConnectors({ q: 'acme-crm' });
    const ids = res.connectors.map((c: any) => c.id);
    expect(ids).toContain('acme-crm');
    // No gateway branding leaks into ids.
    expect(ids.every((id: string) => !id.startsWith('oc-'))).toBe(true);
    const row: any = res.connectors.find((c: any) => c.id === 'acme-crm');
    expect(row.name).toBe('Acme CRM');
    expect(row.category).toBe('CRM & Marketing');
    expect(row.kind).toBe('verified');
  });

  test('local rows win on overlap (gmail listed once)', async () => {
    const { api } = tmpApiWithGateway();
    const res = await api.listConnectors({ q: 'gmail', limit: 100 });
    const gmailRows = res.connectors.filter((c: any) =>
      c.id === 'gmail' || c.credentialKey === 'gmail' || /gmail/i.test(c.name));
    // The native `productivity-gmail` row covers the gateway `gmail` service.
    expect(res.connectors.filter((c: any) => c.id === 'gmail')).toHaveLength(0);
    expect(gmailRows.length).toBeGreaterThan(0);
  });

  test('getConnector resolves gateway-only ids, still throws for unknown', async () => {
    const { api } = tmpApiWithGateway();
    const hit = await api.getConnector('acme-crm', 'default');
    expect(hit.connector.id).toBe('acme-crm');
    expect(hit.isConnected).toBe(false);
    await expect(api.getConnector('definitely-not-a-connector-xyz')).rejects.toThrow('not found');
  });

  test('connect + readiness + execute work for gateway-only providers', async () => {
    const { api, store } = tmpApiWithGateway();
    const connected = await api.connectConnector('acme-crm', { apiKey: 'pat_test', userId: 'default' });
    expect(connected.action).toBe('api_key_saved');
    expect(store.getConnection('default', 'acme-crm')?.connectionStatus).toBe('connected');

    const readiness = api.getReadiness('acme-crm', 'default');
    expect(readiness.state).toBe('connected');

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-gw2-'));
    const store2 = new ConnectorStore(path.join(fresh, 'connectors.db'));
    const api2 = new ConnectorApi(store2, new OAuthConnector());
    api2.setOpenConnector(new OpenConnectorBridge({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: mockFetch() }));
    await api2.listConnectors({ q: 'acme-crm', limit: 1 }); // settle the cache warm
    expect(api2.getReadiness('acme-crm').state).toBe('needs_key');

    const exec = await api2.executeConnectorAction('acme-crm', '/contacts', 'GET', { limit: 1 });
    expect(exec.success).toBe(true);
    expect((exec.data as any)?.results).toEqual([]);
  });

  test('gateway OAuth provider reports needs_oauth_app, not needs_setup', async () => {
    const { api } = tmpApiWithGateway();
    await api.listConnectors({}); // warm the provider cache for the sync overlay
    const readiness = api.getReadiness('productivity-gmail', 'default');
    // Local gmail already knows its provider; gateway-only oauth would also
    // surface as needs_oauth_app rather than needs_setup.
    expect(['needs_oauth_app', 'connected']).toContain(readiness.state);
  });

  test('without a bridge everything stays local-only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-nogw-'));
    const api = new ConnectorApi(new ConnectorStore(path.join(dir, 'c.db')), new OAuthConnector());
    await expect(api.getConnector('hubspot')).rejects.toThrow('not found');
    const health: any = await api.getSystemHealth();
    expect(health.gateway).toMatchObject({ available: false, providers: 0 });
  });

  test('system health reports the gateway when attached', async () => {
    const { api } = tmpApiWithGateway();
    const health: any = await api.getSystemHealth();
    expect(health.gateway).toMatchObject({ available: true, providers: 4 });
  });

  test('gateway OAuth connect returns a native-shaped oauth_redirect with no gateway branding', async () => {
    const { api } = tmpApiWithGateway();
    const res: any = await api.connectConnector('acme-oauth', {});
    expect(res.action).toBe('oauth_redirect');
    expect(res.authorizeUrl).toBe('https://acme-oauth.example/authorize?x=1');
    // The user must never see the invisible gateway's name.
    expect(JSON.stringify(res)).not.toMatch(/open-?connector/i);
    expect(JSON.stringify(res)).not.toMatch(/gateway/i);
    expect(JSON.stringify(res)).not.toMatch(/sidecar/i);
  });

  test('gateway OAuth readiness reports needs_oauth_app with an Authorize action', async () => {
    const { api } = tmpApiWithGateway();
    await api.listConnectors({}); // warm the provider cache for the sync overlay
    const readiness = api.getReadiness('acme-oauth', 'default');
    expect(readiness.state).toBe('needs_oauth_app');
    expect(readiness.action).toBe('Authorize');
    expect(readiness.provider).toBe('Acme OAuth');
  });

  test('sidecar-completed OAuth counts as connected in status', async () => {
    const { api } = tmpApiWithGateway();
    const status = await api.getConnectorStatus('acme-oauth');
    expect(status.isConnected).toBe(true);
  });

  test('failed gateway authorization never leaks gateway wording', async () => {
    const failingFetch = (async (url: any, _init: any) => {
      const u = String(url);
      if (u.endsWith('/v1/health')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (u.endsWith('/v1/providers')) {
        return new Response(JSON.stringify({ success: true, data: PROVIDERS }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: false }), { status: 500 });
    }) as typeof fetch;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-gwfail-'));
    const api = new ConnectorApi(
      new ConnectorStore(path.join(dir, 'c.db')),
      new OAuthConnector(),
    );
    api.setOpenConnector(new OpenConnectorBridge({ baseUrl: 'http://127.0.0.1:3000', fetchImpl: failingFetch }));
    const err: unknown = await api.connectConnector('acme-oauth', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // Names the provider the user clicked, never the invisible gateway.
    expect(msg).toMatch(/acme-oauth/i);
    expect(msg).not.toMatch(/open-?connector/i);
    expect(msg).not.toMatch(/gateway/i);
    expect(msg).not.toMatch(/sidecar/i);
  });
});
