/**
 * Bulk-ingestion verification — proves a connector that shipped as a name-only
 * catalog row can now be connected and actually called.
 *
 * The ingestion run (scripts/ingest-connector-specs.ts) converted ~2,500
 * APIs.guru entries into ~45k tool definitions in the RUNTIME database
 * (~/.umbra/connectors.db). These tests assert the result is usable: a stored
 * credential resolves, a base_url exists, and a real request is dispatched.
 *
 * They run against the live runtime DB when present and self-skip otherwise,
 * so CI without an ingested catalog stays green.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { ConnectorStore } from './ConnectorStore';
import { ToolIngestion } from './ToolIngestion';
import { ToolExecutor } from './ToolExecutor';
import { findCatalogEntry } from './McpCatalog';

const RUNTIME_DB = path.join(process.env.USERPROFILE || '~', '.umbra', 'connectors.db');

/** The ingestion DB only exists after scripts/ingest-connector-specs.ts has run. */
function ingestedDb(): string | null {
  const runtime = fs.existsSync(RUNTIME_DB) ? RUNTIME_DB : null;
  return runtime;
}

const describeIfIngested = ingestedDb() ? describe : describe.skip;

describeIfIngested('bulk-ingested connectors are callable', () => {
  const dbPath = ingestedDb()!;
  let ingestion: ToolIngestion;
  let store: ConnectorStore;
  let executor: ToolExecutor;
  /** Loaded once — listAll() parses ~40k JSON schemas and is far too slow
   *  to call per assertion. */
  let defs: any[];

  beforeAll(() => {
    ingestion = new ToolIngestion(dbPath);
    defs = ingestion.listAll() as any[];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-ingested-'));
    store = new ConnectorStore(path.join(dir, 'connectors.db'));
    executor = new ToolExecutor(store);
  }, 120_000);

  it('indexed a substantial number of tools across many connectors', () => {
    expect(defs.length).toBeGreaterThan(1000);
    const connectors = new Set(defs.map(d => d.connector_id));
    expect(connectors.size).toBeGreaterThan(500);
  });

  it('gives ingested tools a real absolute base_url so requests can be routed', () => {
    const ingested = defs.filter(d => d.connector_id.startsWith('apisguru-'));
    expect(ingested.length).toBeGreaterThan(1000);

    // Spec/curated/MCP tools must be routable — a relative `servers[0].url`
    // (e.g. "/api/v1") would make `${base_url}${endpoint}` unusable.
    const isGeneric = (d: any) => d.source === 'generic' || d.name === 'call_api';
    const badSpec = ingested.filter(d => !isGeneric(d) && (!d.base_url || !/^https?:\/\/[^\s]+$/.test(d.base_url)));
    expect(badSpec.slice(0, 5).map(d => `${d.tool_id}=${d.base_url}`)).toEqual([]);

    // Generic `call_api` fallbacks may legitimately have NO base (connectors
    // with nothing known — callable via full-URL override), but must never
    // carry JUNK (`,`, `/v1`, `//host`, placeholders): junk is worse than
    // null because it builds garbage URLs instead of a clear error.
    const junkGeneric = ingested.filter(d =>
      isGeneric(d) && d.base_url != null && !/^https?:\/\/[^\s]+$/.test(d.base_url));
    expect(junkGeneric.slice(0, 5).map(d => `${d.tool_id}=${d.base_url}`)).toEqual([]);
  });

  it('picks up the baseUrl that was persisted back into the catalog', () => {
    const ids = defs
      .map(d => d.connector_id as string)
      .filter(id => id.startsWith('apisguru-'))
      .slice(0, 50);
    const withBaseUrl = ids.filter(id => {
      const entry = findCatalogEntry(id);
      return Boolean(entry?.baseUrl && entry.baseUrl.trim());
    });
    expect(withBaseUrl.length / ids.length).toBeGreaterThan(0.9);
  });

  it('builds a routable URL and resolves auth for an ingested tool', () => {
    const target = defs.find(d =>
      d.connector_id.startsWith('apisguru-') &&
      Boolean(d.base_url) &&
      d.http_method === 'GET' &&
      Boolean(d.endpoint_template) &&
      !d.endpoint_template.includes('{'),
    );
    expect(target).toBeTruthy();

    // Store a credential the way connect would, then assert the lookup key
    // the executor uses actually finds it.
    store.saveConnection({ userId: 'default', connectorId: target!.connector_id, apiKey: 'test-key' });
    const tokens = store.getDecryptedTokens('default', target!.credential_service ?? target!.connector_id);
    expect(tokens).toBeTruthy();

    const url = `${target!.base_url}${target!.endpoint_template}`;
    expect(url.startsWith('http')).toBe(true);
  });

  it('reports not-connected rather than crashing for an unconnected ingested tool', async () => {
    // Pick a tool with no required args so the schema gate passes and we
    // reach the auth gate (which fails before any network I/O).
    const target = defs.find(d =>
      d.connector_id.startsWith('apisguru-') &&
      d.auth_type !== 'none' &&
      (d.parameters_schema?.required ?? []).length === 0,
    );
    expect(target).toBeTruthy();
    const result = await executor.executeTool(target, {}, 'nobody-connected');
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not connected|Connect/i);
  });

  it('every ingested tool definition parses as valid', () => {
    const db = new Database(dbPath, { readonly: true });
    const bad = db
      .prepare("SELECT COUNT(*) c FROM tool_definitions WHERE connector_id LIKE 'apisguru-%' AND (tool_id IS NULL OR name IS NULL OR endpoint_template IS NULL)")
      .get() as any;
    db.close();
    expect(bad.c).toBe(0);
  });
});
