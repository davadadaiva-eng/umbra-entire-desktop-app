/**
 * Unit coverage for ConnectorApi.ingestOpenApiSpec — the on-demand ingestion
 * path behind POST /api/connectors/ingest-openapi. Route-level tests mock the
 * dep; this file exercises the REAL implementation against a real
 * ToolIngestion store (validation, catalog defaults, replace semantics).
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectorApi } from './ConnectorApi';
import { ToolIngestion } from './ToolIngestion';

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-ingest-api-'));
  return path.join(dir, 'connectors.db');
}

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Toys', version: '1.0' },
  paths: {
    '/toys': {
      get: {
        operationId: 'listToys',
        summary: 'List toys',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      },
      post: {
        operationId: 'createToy',
        summary: 'Create a toy',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
        },
      },
    },
  },
};

/** Minimal store stub — the ingestion path never touches credentials. */
function makeApi(dbPath: string): ConnectorApi {
  const store = {} as ConstructorParameters<typeof ConnectorApi>[0];
  return new ConnectorApi(store, undefined, undefined, new ToolIngestion(dbPath));
}

describe('ConnectorApi.ingestOpenApiSpec', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
  });

  it('ingests an inline spec with replace semantics', async () => {
    const api = makeApi(dbPath);

    const first = await api.ingestOpenApiSpec({ connectorId: 'toy-store', spec: SPEC });
    expect(first.ingested).toBe(2);
    expect(first.removed).toBe(0);
    expect(first.replaced).toBe(false);

    // Re-ingest: replace drops the previous definitions, no duplicates.
    const second = await api.ingestOpenApiSpec({ connectorId: 'toy-store', spec: SPEC });
    expect(second.ingested).toBe(2);
    expect(second.removed).toBe(2);
    expect(second.replaced).toBe(true);
    expect(second.total).toBe(first.total);
  });

  it('applies catalog defaults for known connectors (no baseUrl needed)', async () => {
    const api = makeApi(dbPath);
    const res = await api.ingestOpenApiSpec({ connectorId: 'search-research-wikipedia', spec: SPEC });
    expect(res.catalogMatch).toBe(true);
    expect(res.baseUrl).toBe('https://en.wikipedia.org');
    expect(res.authType).toBe('none');
  });

  it('explicit options override catalog defaults', async () => {
    const api = makeApi(dbPath);
    const res = await api.ingestOpenApiSpec({
      connectorId: 'search-research-wikipedia',
      spec: SPEC,
      baseUrl: 'https://mirror.test',
      authType: 'apiKey',
      apiKeyHeader: 'X-Key',
    });
    expect(res.baseUrl).toBe('https://mirror.test');
    expect(res.authType).toBe('apiKey');
  });

  it('rejects missing connectorId, missing spec source, and spec without paths', async () => {
    const api = makeApi(dbPath);
    await expect(api.ingestOpenApiSpec({ spec: SPEC } as never)).rejects.toThrow(/connectorId is required/);
    await expect(api.ingestOpenApiSpec({ connectorId: 'x' })).rejects.toThrow(/spec or specUrl is required/);
    await expect(api.ingestOpenApiSpec({ connectorId: 'x', spec: { openapi: '3.0.0' } })).rejects.toThrow(/no supported REST operations/i);
  });
});
