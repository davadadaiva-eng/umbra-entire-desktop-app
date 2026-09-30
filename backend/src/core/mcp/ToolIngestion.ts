/**
 * ToolIngestion — metadata indexing pipeline (the "RAG for tools" ingest half).
 *
 * Converts three sources into standardized ToolDefinitions and persists them
 * in the `tool_definitions` sqlite table (connectors.db, WAL — safe to share
 * with ConnectorStore):
 *
 *   1. Curated schemas   (curatedTools.ts — highest quality, always loaded)
 *   2. OpenAPI / Swagger (per-connector spec ingestion)
 *   3. MCP `tools/list`  (per-server capability discovery)
 *
 * Flat-args contract (uniform for curated + ingested REST tools):
 *   - path placeholders (`{id}`) map to required string properties,
 *   - query parameters are flattened into properties,
 *   - request-body object schemas are flattened into top-level properties
 *     (the executor re-assembles the JSON body from non-path arguments),
 *   - non-object bodies are represented as a single `body` property.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';
import {
  ToolDefinition,
  ToolDefinitionSchema,
  JsonSchemaObject,
  JsonSchemaProperty,
  parseToolDefinition,
  makeToolId,
} from './ToolDefinition';
import { CURATED_TOOLS } from './curatedTools';

// ── OpenAPI parsing types (structural subset — real specs are messy) ──

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: Array<string | number>; description?: string; [k: string]: unknown };
  /** Swagger 2.0 carries type/enum directly on the parameter. */
  type?: string;
  enum?: Array<string | number>;
  [k: string]: unknown;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  [k: string]: unknown;
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  parameters?: OpenApiParameter[];
  [k: string]: unknown;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// ── ToolIngestion ───────────────────────────────────────────────────

export class ToolIngestion {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_definitions (
        tool_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT,
        auth_type TEXT,
        transport TEXT,
        endpoint_template TEXT,
        base_url TEXT,
        http_method TEXT,
        credential_service TEXT,
        api_key_header TEXT,
        schema_quality TEXT,
        source TEXT,
        parameters_schema TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_def_connector ON tool_definitions(connector_id);
    `);
  }

  /** Upsert definitions in one transaction. Returns the number stored. */
  upsertDefinitions(defs: ToolDefinition[]): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tool_definitions
        (tool_id, connector_id, name, description, category, auth_type, transport,
         endpoint_template, base_url, http_method, credential_service, api_key_header,
         schema_quality, source, parameters_schema, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        category = excluded.category,
        auth_type = excluded.auth_type,
        transport = excluded.transport,
        endpoint_template = excluded.endpoint_template,
        base_url = excluded.base_url,
        http_method = excluded.http_method,
        credential_service = excluded.credential_service,
        api_key_header = excluded.api_key_header,
        schema_quality = excluded.schema_quality,
        source = excluded.source,
        parameters_schema = excluded.parameters_schema,
        updated_at = excluded.updated_at
    `);
    const tx = this.db.transaction((rows: ToolDefinition[]) => {
      let n = 0;
      for (const d of rows) {
        stmt.run(
          d.tool_id, d.connector_id, d.name, d.natural_language_description,
          d.category ?? null, d.auth_type ?? null, d.transport ?? null,
          d.endpoint_template ?? null, d.base_url ?? null, d.http_method ?? null,
          d.credential_service ?? null, d.api_key_header ?? null,
          d.schema_quality ?? null, d.source ?? null,
          JSON.stringify(d.parameters_schema), now,
        );
        n++;
      }
      return n;
    });
    return tx(defs);
  }

  /** All stored definitions (validated on read; corrupt rows are skipped). */
  listAll(): ToolDefinition[] {
    const rows = this.db.prepare('SELECT * FROM tool_definitions').all() as any[];
    const out: ToolDefinition[] = [];
    for (const r of rows) {
      const def = parseToolDefinition(rowToRaw(r));
      if (def) out.push(def);
    }
    return out;
  }

  get(toolId: string): ToolDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM tool_definitions WHERE tool_id = ?').get(toolId) as any;
    return row ? parseToolDefinition(rowToRaw(row)) ?? undefined : undefined;
  }

  getForConnector(connectorId: string): ToolDefinition[] {
    const rows = this.db.prepare('SELECT * FROM tool_definitions WHERE connector_id = ?').all(connectorId) as any[];
    const out: ToolDefinition[] = [];
    for (const r of rows) {
      const def = parseToolDefinition(rowToRaw(r));
      if (def) out.push(def);
    }
    return out;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tool_definitions').get() as any;
    return row?.n ?? 0;
  }

  /** Remove every definition for one connector (replace-semantics re-ingest). */
  deleteForConnector(connectorId: string): number {
    const info = this.db.prepare('DELETE FROM tool_definitions WHERE connector_id = ?').run(connectorId);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }

  // ── Source 1: curated ─────────────────────────────────────────────

  /** Load/refresh the curated tool set. Returns number stored. */
  loadCurated(): number {
    return this.upsertDefinitions(CURATED_TOOLS);
  }

  // ── Source 2: OpenAPI / Swagger ───────────────────────────────────

  /**
   * Ingest an OpenAPI 3.x / Swagger 2.x JSON spec for one connector.
   * Returns the number of ToolDefinitions stored.
   */
  ingestOpenApi(
    connectorId: string,
    spec: unknown,
    opts: {
      baseUrl?: string;
      authType?: ToolDefinition['auth_type'];
      credentialService?: string;
      apiKeyHeader?: string;
      category?: string;
      /** Only ingest paths matching this prefix (default: all). */
      pathPrefix?: string;
      maxTools?: number;
    } = {},
  ): number {
    if (!spec || typeof spec !== 'object') {
      getLogger().warn({ connectorId }, 'OpenAPI ingestion skipped: spec is not an object');
      return 0;
    }
    const s = spec as Record<string, unknown>;
    const paths = (s.paths ?? {}) as Record<string, OpenApiPathItem>;
    const maxTools = opts.maxTools ?? 200;

    const defs: ToolDefinition[] = [];
    for (const [p, item] of Object.entries(paths)) {
      if (opts.pathPrefix && !p.startsWith(opts.pathPrefix)) continue;
      if (defs.length >= maxTools) break;
      const pathParams = mergeParams(item.parameters);

      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op || defs.length >= maxTools) continue;
        const allParams = mergeParams(pathParams, op.parameters);

        const properties: Record<string, JsonSchemaProperty> = {};
        const required = new Set<string>();

        for (const param of allParams) {
          if (!param?.name) continue;
          const type = normalizeType(param.schema?.type ?? param['type'] ?? 'string');
          properties[param.name] = materializeProperty(spec as Record<string, unknown>, {
            type,
            description: param.schema?.description ?? param.description,
            enum: (param.schema?.enum ?? param['enum']) as JsonSchemaProperty['enum'],
          });
          // Path + required query parameters become required args.
          if (param.in === 'path' || param.required === true) required.add(param.name);
        }

        // Request body: flatten object schemas; wrap others as `body`.
        const bodyEntry = op.requestBody?.content?.['application/json']
          ?? op.requestBody?.content?.['application/x-www-form-urlencoded'];
        const bodySchema = bodyEntry?.schema as JsonSchemaProperty | undefined;
        if (bodySchema) {
          const specObj = spec as Record<string, unknown>;
          const resolved = materializeProperty(specObj, bodySchema as JsonSchemaProperty);
          if (resolved.type === 'object' && resolved.properties) {
            for (const [k, prop] of Object.entries(resolved.properties)) {
              properties[k] = prop;
            }
            for (const r of resolved.required ?? []) required.add(r);
          } else {
            // Array / primitive bodies become a single `body` property
            // (items resolved, so nested $refs survive read-back).
            properties.body = { ...resolved, description: bodySchema.description ?? 'Request body.' };
            if (op.requestBody?.required) required.add('body');
          }
        }

        if (Object.keys(properties).length === 0) {
          properties.payload = { type: 'object', description: 'Optional request payload.' };
        }

        const name = toolSlug(
          op.operationId
            || `${method}_${p.replace(/[^a-zA-Z0-9]+/g, '_')}`,
        );
        const description = op.summary || op.description || `${method.toUpperCase()} ${p}`;

        const def: ToolDefinition = {
          tool_id: makeToolId(connectorId, name),
          connector_id: connectorId,
          name,
          natural_language_description: description,
          category: opts.category ?? 'OpenAPI',
          parameters_schema: { type: 'object', properties, required: [...required], additionalProperties: true },
          auth_type: opts.authType ?? 'none',
          transport: 'rest',
          endpoint_template: p,
          http_method: method.toUpperCase() as ToolDefinition['http_method'],
          schema_quality: 'openapi',
          source: 'openapi',
        };
        if (opts.baseUrl) def.base_url = opts.baseUrl;
        if (opts.credentialService) def.credential_service = opts.credentialService;
        if (opts.apiKeyHeader) def.api_key_header = opts.apiKeyHeader;
        defs.push(def);
      }
    }

    const stored = this.upsertDefinitions(defs);
    getLogger().info({ connectorId, ingested: stored }, 'OpenAPI tools ingested');
    return stored;
  }

  // ── Source 3: MCP tools/list ──────────────────────────────────────

  /**
   * Ingest the `tools` array from an MCP server's `tools/list` response.
   * MCP `inputSchema` is already JSON Schema — it is stored as-is
   * (validated) with transport `mcp`.
   */
  ingestMcpTools(
    connectorId: string,
    tools: Array<{ name?: string; description?: string; inputSchema?: unknown }>,
    opts: { category?: string; baseUrl?: string; credentialService?: string } = {},
  ): number {
    const defs: ToolDefinition[] = [];
    for (const t of tools) {
      if (!t?.name) continue;
      const raw = t.inputSchema;
      const schema: JsonSchemaObject = isObjectSchema(raw)
        ? (raw as JsonSchemaObject)
        : { type: 'object', properties: {}, required: [], additionalProperties: true };
      const def: ToolDefinition = {
        tool_id: makeToolId(connectorId, toolSlug(t.name)),
        connector_id: connectorId,
        name: toolSlug(t.name),
        natural_language_description: t.description || `MCP tool ${t.name}`,
        category: opts.category ?? 'MCP',
        parameters_schema: schema,
        auth_type: opts.credentialService ? 'apiKey' : 'none',
        transport: 'mcp',
        base_url: opts.baseUrl,
        credential_service: opts.credentialService,
        schema_quality: 'mcp',
        source: 'mcp',
      };
      const parsed = ToolDefinitionSchema.safeParse(def);
      if (parsed.success) defs.push(parsed.data);
    }
    const stored = this.upsertDefinitions(defs);
    getLogger().info({ connectorId, ingested: stored }, 'MCP tools ingested');
    return stored;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function rowToRaw(r: any): Record<string, unknown> {
  return {
    tool_id: r.tool_id,
    connector_id: r.connector_id,
    name: r.name,
    natural_language_description: r.description,
    category: r.category ?? undefined,
    parameters_schema: r.parameters_schema,
    auth_type: r.auth_type ?? undefined,
    transport: r.transport ?? undefined,
    endpoint_template: r.endpoint_template ?? undefined,
    base_url: r.base_url ?? undefined,
    http_method: r.http_method ?? undefined,
    credential_service: r.credential_service ?? undefined,
    api_key_header: r.api_key_header ?? undefined,
    schema_quality: r.schema_quality ?? undefined,
    source: r.source ?? undefined,
  };
}

function mergeParams(...lists: Array<OpenApiParameter[] | undefined>): OpenApiParameter[] {
  const seen = new Set<string>();
  const out: OpenApiParameter[] = [];
  for (const list of lists) {
    for (const p of list ?? []) {
      if (p?.name && !seen.has(p.name)) {
        seen.add(p.name);
        out.push(p);
      }
    }
  }
  return out;
}

function normalizeType(t: unknown): JsonSchemaProperty['type'] {
  const s = String(t ?? 'string').toLowerCase();
  if (s === 'integer' || s === 'number') return 'number';
  if (s === 'boolean') return 'boolean';
  if (s === 'array') return 'array';
  if (s === 'object') return 'object';
  return 'string';
}

/**
 * Recursively materialize a schema node: resolve local `$ref` pointers
 * against the spec (real-world specs are full of them, including inside
 * array items) and give every node a concrete `type`.
 *
 * Both steps matter for storage: schemas without `type` fail
 * ToolDefinitionSchema on read-back and the tool is silently dropped.
 * Unresolvable/untyped nodes are typed by shape:
 *   has properties → object, has items → array, else → string.
 */
const MAX_REF_DEPTH = 6;

function materializeProperty(spec: Record<string, unknown>, schema: JsonSchemaProperty, depth = 0): JsonSchemaProperty {
  let out: JsonSchemaProperty = { ...schema };

  // Resolve local JSON-pointer refs ("#/components/schemas/Pet"). The ref
  // site's own keys (description, …) win over the target's.
  const ref = (out as Record<string, unknown>)['$ref'];
  if (typeof ref === 'string' && depth < MAX_REF_DEPTH) {
    const target = lookupRef(spec, ref);
    if (target) {
      const { $ref: _dropped, ...siblings } = out as Record<string, unknown>;
      out = { ...target, ...siblings } as JsonSchemaProperty;
    }
  }

  if (!out.type) {
    if (out.properties) out.type = 'object';
    else if (out.items) out.type = 'array';
    else out.type = 'string';
  }
  if (out.items) out.items = materializeProperty(spec, out.items, depth + 1);
  if (out.properties) {
    const props: Record<string, JsonSchemaProperty> = {};
    for (const [k, v] of Object.entries(out.properties)) {
      props[k] = materializeProperty(spec, v, depth + 1);
    }
    out.properties = props;
  }
  return out;
}

/** Walk a local JSON pointer (RFC 6901, `#/a/b`); undefined when dangling. */
function lookupRef(spec: Record<string, unknown>, ref: string): JsonSchemaProperty | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = spec;
  for (const raw of ref.slice(2).split('/')) {
    const token = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node && typeof node === 'object' && token in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return node && typeof node === 'object' && !Array.isArray(node) ? (node as JsonSchemaProperty) : undefined;
}

/** Deterministic, LLM-safe function name (≤64 chars, [a-z0-9_]). Splits camelCase. */
function toolSlug(name: string): string {
  const cased = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return cased.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56) || 'tool';
}

function isObjectSchema(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as any).type === 'object';
}
