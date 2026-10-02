/**
 * Tests for on-demand tool ingestion — the mechanism that turns a name-only
 * catalog row into a callable connector.
 *
 * Covers the two load-bearing assumptions behind the bulk-ingestion plan:
 *   1. An OpenAPI spec with no explicit baseUrl yields a usable baseUrl
 *      (derived from `servers[0]`), so the executor can route calls.
 *   2. `ensureConnectorTools` is idempotent — repeat calls do not re-ingest.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectorApi } from './ConnectorApi';
import { ConnectorStore } from './ConnectorStore';
import { ToolIngestion } from './ToolIngestion';

const SPEC_WITH_SERVER = {
  openapi: '3.0.0',
  info: { title: 'Widget API', version: '1.0.0' },
  servers: [{ url: 'https://api.widget.example.com/v1' }],
  paths: {
    '/widgets': {
      get: { operationId: 'listWidgets', summary: 'List widgets', responses: { '200': { description: 'ok' } } },
      post: {
        operationId: 'createWidget',
        summary: 'Create a widget',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/widgets/{id}': {
      get: {
        operationId: 'getWidget',
        summary: 'Fetch one widget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

describe('ensureConnectorTools', () => {
  let dir: string;
  let store: ConnectorStore;
  let api: ConnectorApi;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-ingest-'));
    const dbPath = path.join(dir, 'connectors.db');
    store = new ConnectorStore(dbPath);
    const ingestion = new ToolIngestion(path.join(dir, 'tools.db'));
    api = new ConnectorApi(store, undefined, undefined, ingestion as any);
  });

  // Temp dirs are intentionally left behind: SQLite holds file handles on
  // Windows, so removing them while open throws EPERM. Matches the pattern in
  // ConnectorApi.ingest.test.ts.

  it('derives a baseUrl from servers[0] when the catalog entry has none', async () => {
    const spec = ingestionSpecFrom(SPEC_WITH_SERVER);
    const result = await api.ingestOpenApiSpec({ connectorId: 'toy-widget', spec });

    expect(result.ingested).toBeGreaterThan(0);
    // The whole point: a catalog row with baseUrl:'' becomes routable.
    expect(result.baseUrl).toBe('https://api.widget.example.com/v1');

    const tools = ingestionRead(api, 'toy-widget');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(t => t.base_url === 'https://api.widget.example.com/v1')).toBe(true);
  });

  it('flattens path params and request bodies into tool parameters', async () => {
    await api.ingestOpenApiSpec({ connectorId: 'toy-widget', spec: ingestionSpecFrom(SPEC_WITH_SERVER) });
    const tools = ingestionRead(api, 'toy-widget');

    // Tool names are slugged (lower_snake) on ingestion.
    const byName = new Map(tools.map(t => [t.name, t]));
    expect(byName.has('list_widgets')).toBe(true);
    expect(byName.has('create_widget')).toBe(true);
    expect(byName.has('get_widget')).toBe(true);

    // `id` is a path placeholder → required string property.
    const getOne = byName.get('get_widget')!;
    expect(getOne.parameters_schema.required).toContain('id');
    // Request body properties are lifted to the top level.
    const create = byName.get('create_widget')!;
    expect(Object.keys(create.parameters_schema.properties)).toContain('name');
  });

  it('is idempotent — a second ensureConnectorTools call does not re-ingest', async () => {
    const spec = ingestionSpecFrom(SPEC_WITH_SERVER);
    await api.ingestOpenApiSpec({ connectorId: 'toy-widget', spec });

    const again = await api.ensureConnectorTools('toy-widget');
    expect(again.alreadyIndexed).toBe(true);
    expect(again.ingested).toBeGreaterThan(0);
    // No duplicate rows.
    expect(ingestionRead(api, 'toy-widget')).toHaveLength(again.ingested);
  });

  it('short-circuits when curated tools already cover the connector', async () => {
    // Gmail has curated tools, so no spec fetch is attempted.
    const r = await api.ensureConnectorTools('productivity-gmail');
    expect(r.alreadyIndexed).toBe(true);
    expect(r.source).toBe('curated');
    expect(r.baseUrl).toBe('https://gmail.googleapis.com');
  });

  it('reports a clear error when a connector has neither tools nor a spec', async () => {
    // A real catalog entry with authType oauth but no curated tools and no
    // specUrl — the honest error, not a silent no-op.
    await expect(api.ensureConnectorTools('automotive-mobility-mercedes-benz'))
      .rejects.toThrow(/No tool schema or OpenAPI spec/);
  });

  it('reports a clear error for an id that is not in the catalog', async () => {
    await expect(api.ensureConnectorTools('developer-totally-unknown-thing'))
      .rejects.toThrow(/not found/);
  });

  it('replaces prior definitions rather than accumulating duplicates on re-ingest', async () => {
    const spec = ingestionSpecFrom(SPEC_WITH_SERVER);
    await api.ingestOpenApiSpec({ connectorId: 'toy-widget', spec });
    const first = ingestionRead(api, 'toy-widget').length;

    const second = await api.ingestOpenApiSpec({ connectorId: 'toy-widget', spec });
    expect(second.removed).toBe(first);
    expect(ingestionRead(api, 'toy-widget')).toHaveLength(second.ingested);
  });

  it('rejects a spec with no usable REST operations', async () => {
    await expect(
      api.ingestOpenApiSpec({ connectorId: 'empty-api', spec: { openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {} } }),
    ).rejects.toThrow(/no supported REST operations/);
  });
});

describe('readiness reporting', () => {
  let dir: string;
  let store: ConnectorStore;
  let api: ConnectorApi;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-ready-'));
    store = new ConnectorStore(path.join(dir, 'connectors.db'));
    const ingestion = new ToolIngestion(path.join(dir, 'tools.db'));
    api = new ConnectorApi(store, undefined, undefined, ingestion as any);
  });

  // See the note above: temp dirs are left in place (Windows file locks).

  it('marks no-auth connectors as ready', () => {
    const r = api.getReadiness('search-research-wikipedia');
    expect(r.state).toBe('ready');
    expect(r.authType).toBe('none');
  });

  it('marks a known OAuth provider as needing an app, and names the provider', () => {
    const r = api.getReadiness('productivity-gmail');
    expect(r.state).toBe('needs_oauth_app');
    expect(r.provider).toBe('Google');
    expect(r.action).toMatch(/credentials/i);
  });

  it('reports connected once a connection row exists', () => {
    store.saveConnection({ userId: 'default', connectorId: 'productivity-gmail', apiKey: 'x' });
    expect(api.getReadiness('productivity-gmail').state).toBe('connected');
  });

  it('falls back to needs_setup rather than pretending a connector is ready', () => {
    const r = api.getReadiness('apisguru-googleapis-com-fusiontables');
    expect(['needs_key', 'needs_setup']).toContain(r.state);
    expect(r.action).not.toBe('Connect');
  });

  it('summary counts every catalog entry exactly once', () => {
    const summary = api.getReadinessSummary();
    const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(summary.connectors.length);
    expect(total).toBeGreaterThan(3000);
  });
});

// ── helpers ─────────────────────────────────────────────────────────

function ingestionSpecFrom(spec: unknown): unknown {
  return JSON.parse(JSON.stringify(spec));
}

function ingestionRead(api: ConnectorApi, connectorId: string): any[] {
  // Reach the definition store through the public listing API.
  const all = (api as any).toolSchemas.listAll() as any[];
  return all.filter(d => d.connector_id === connectorId);
}
