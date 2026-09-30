/**
 * VectorToolRegistry — semantic JIT tool retrieval over indexed
 * ToolDefinitions ("RAG for tools" retrieve half).
 *
 * Flow:
 *   boot  → index(defs) embeds each tool's description ONCE (cached by text
 *           hash in sqlite, so restarts are instant for unchanged tools)
 *   query → search(intent) embeds the user prompt and returns the top-K
 *           most relevant tool schemas — ONLY those reach the LLM context.
 *
 * Degradation ladder (retrieval never fails):
 *   1. sqlite-vec KNN when the extension loads (fast, indexed)
 *   2. brute-force cosine over in-memory vectors (≤ a few thousand tools —
 *      sub-5ms, fully deterministic)
 *   3. keyword scoring fallback when no embedder is reachable (offline mode)
 *
 * Embeddings come from the injected embedder (LLMConnector.createEmbedding —
 * Ollama/OpenAI per config). Tests inject a deterministic fake embedder.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition } from './ToolDefinition';
import { getLogger } from '../Logger';

// ── Types ───────────────────────────────────────────────────────────

export type Embedder = (text: string) => Promise<number[]>;

export interface RetrievedTool {
  def: ToolDefinition;
  /** Similarity score (cosine similarity for vector, 0..1-ish for keyword). */
  score: number;
  source: 'vector' | 'keyword';
}

export interface SearchFilter {
  connectorId?: string;
  transport?: ToolDefinition['transport'];
  schemaQuality?: ToolDefinition['schema_quality'];
}

export interface VectorToolRegistryOptions {
  embedder?: Embedder;
  /** Last-resort keyword scorer (wired to ToolRetriever at boot). May be async. */
  keywordSearch?: (query: string, limit: number, filter?: SearchFilter) => ToolDefinition[] | Promise<ToolDefinition[]>;
}

export interface VectorRegistryStatus {
  indexed: number;
  dimension: number | null;
  mode: 'vector' | 'keyword';
  vecExtension: boolean;
  embedder: boolean;
}

// ── Registry ────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

export class VectorToolRegistry {
  private db: Database.Database;
  private options: VectorToolRegistryOptions;
  private vecAvailable = false;
  /** tool_id → embedding (loaded from sqlite at boot, updated on index). */
  private vectors = new Map<string, number[]>();
  /** tool_id → definition. */
  private defs = new Map<string, ToolDefinition>();
  /** tool_id → hash of the embedded text (cache invalidation). */
  private hashes = new Map<string, string>();
  private dim: number | null = null;

  constructor(dbPath: string, options: VectorToolRegistryOptions = {}) {
    this.options = options;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.init();
    this.tryLoadVec();
    this.loadFromDb();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_vectors (
        tool_id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        text_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION}
      );
    `);
  }

  private tryLoadVec(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const vec = require('sqlite-vec');
      this.db.loadExtension(vec.getLoadablePath());
      this.db.exec('SELECT vec_version()');
      this.vecAvailable = true;
    } catch (e) {
      this.vecAvailable = false;
      getLogger().debug(
        { err: (e as Error).message },
        'sqlite-vec unavailable for tool registry — using brute-force cosine',
      );
    }
  }

  /** Load persisted embeddings + (re)register their definitions. */
  private loadFromDb(): void {
    try {
      // schema_version MUST be selected — it gates every row below.
      const rows = this.db.prepare('SELECT tool_id, dim, embedding, text_hash, schema_version FROM tool_vectors').all() as any[];
      for (const r of rows) {
        if (r.schema_version !== SCHEMA_VERSION) continue;
        const arr = blobToFloats(r.embedding);
        this.vectors.set(r.tool_id, arr);
        this.hashes.set(r.tool_id, r.text_hash);
        if (this.dim === null) this.dim = r.dim;
      }
      if (rows.length > 0) {
        getLogger().info({ count: rows.length, dim: this.dim }, 'Tool vector cache loaded');
      }
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'Tool vector cache load failed — starting empty');
    }
  }

  /** Register definitions so cached vectors can be resolved to schemas. */
  registerDefinitions(defs: ToolDefinition[]): void {
    for (const d of defs) this.defs.set(d.tool_id, d);
  }

  /**
   * Drop every vector/definition belonging to one connector (called before
   * re-indexing a replacement set after on-demand re-ingestion).
   */
  evictConnector(connectorId: string): number {
    const doomed: string[] = [];
    for (const [toolId, def] of this.defs) {
      if (def.connector_id === connectorId) doomed.push(toolId);
    }
    for (const toolId of doomed) {
      this.defs.delete(toolId);
      this.vectors.delete(toolId);
      this.hashes.delete(toolId);
    }
    if (doomed.length > 0) {
      try {
        const del = this.db.prepare('DELETE FROM tool_vectors WHERE tool_id = ?');
        this.db.transaction(() => { for (const toolId of doomed) del.run(toolId); })();
      } catch (e) {
        getLogger().warn({ err: (e as Error).message, connectorId }, 'Vector eviction persist failed');
      }
    }
    return doomed.length;
  }

  /** Late-wire the embedder (e.g. after the LLM connector is constructed). */
  setEmbedder(embedder: Embedder): void {
    this.options.embedder = embedder;
  }

  /** Late-wire the keyword fallback scorer (bridges the legacy catalog). */
  setKeywordSearch(search: NonNullable<VectorToolRegistryOptions['keywordSearch']>): void {
    this.options.keywordSearch = search;
  }

  /** The text that gets embedded for a tool. Stable — hash-keyed cache. */
  private embedText(def: ToolDefinition): string {
    const params = Object.keys(def.parameters_schema.properties ?? {}).join(', ');
    return `${def.name}: ${def.natural_language_description}${params ? ` (parameters: ${params})` : ''}`;
  }

  /**
   * Embed + persist tools that are new or whose text changed.
   * Skips everything when no embedder is available (keyword fallback mode).
   *
   * Two call forms:
   *   index(defs, opts)            — index the given definitions (boot path)
   *   index({ defs, force, ... })  — object form; `defs` omitted means
   *                                  re-index everything already registered
   *                                  (post-ingestion replacement path)
   *
   * @returns number of tools actually embedded this call
   */
  async index(
    defsOrOpts: ToolDefinition[] | { defs?: ToolDefinition[]; force?: boolean; onProgress?: (done: number, total: number) => void } = {},
    maybeOpts: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<number> {
    let defs: ToolDefinition[] | undefined;
    let opts: { force?: boolean; onProgress?: (done: number, total: number) => void };
    if (Array.isArray(defsOrOpts)) {
      defs = defsOrOpts;
      opts = maybeOpts;
    } else {
      opts = defsOrOpts;
    }
    const list = defs ?? [...this.defs.values()];

    // Register definitions FIRST so keyword fallback works even without an
    // embedder (retrieval must never depend on vector mode being available).
    this.registerDefinitions(list);
    const embedder = this.options.embedder;
    if (!embedder) {
      getLogger().info('VectorToolRegistry: no embedder — retrieval stays in keyword mode');
      return 0;
    }

    // Determine dimension from the first embedding (needed before storing).
    let done = 0;
    let embedded = 0;
    for (const def of list) {
      done++;
      const text = this.embedText(def);
      const hash = fnv1a(text);
      if (!opts.force && this.hashes.get(def.tool_id) === hash && this.vectors.has(def.tool_id)) {
        continue;
      }
      try {
        const vec = await embedder(text);
        if (!Array.isArray(vec) || vec.length === 0) throw new Error('empty embedding');
        if (this.dim === null) this.dim = vec.length;
        if (vec.length !== this.dim) throw new Error(`dim mismatch: ${vec.length} != ${this.dim}`);
        this.vectors.set(def.tool_id, vec);
        this.hashes.set(def.tool_id, hash);
        this.defs.set(def.tool_id, def);
        embedded++;
      } catch (err) {
        // Per-tool failure is non-fatal — the tool just stays keyword-only.
        getLogger().debug({ toolId: def.tool_id, err: (err as Error).message }, 'Tool embedding failed');
      }
      opts.onProgress?.(done, list.length);
    }

    if (embedded > 0) this.persist();
    getLogger().info(
      { total: list.length, embedded, dim: this.dim, vecExtension: this.vecAvailable },
      'Tool vector indexing complete',
    );
    return embedded;
  }

  private persist(): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_vectors (tool_id, dim, embedding, text_hash, schema_version)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tool_id) DO UPDATE SET
        dim = excluded.dim, embedding = excluded.embedding,
        text_hash = excluded.text_hash, schema_version = excluded.schema_version
    `);
    const tx = this.db.transaction(() => {
      for (const [toolId, vec] of this.vectors) {
        stmt.run(toolId, vec.length, floatsToBlob(vec), this.hashes.get(toolId) ?? '', SCHEMA_VERSION);
      }
    });
    tx();
  }

  /**
   * Semantic search: embed the query, rank all indexed tools by cosine
   * similarity, return the top-K. Falls back to keyword scoring when no
   * embedder is configured or nothing is indexed yet.
   */
  async search(
    query: string,
    k = 5,
    filter?: SearchFilter,
  ): Promise<RetrievedTool[]> {
    if (!query.trim()) return [];

    // Keyword fallback when vector mode is unavailable.
    if (!this.options.embedder || this.vectors.size === 0 || this.dim === null) {
      return this.keywordFallback(query, k, filter);
    }

    let qvec: number[];
    try {
      qvec = await this.options.embedder(query);
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, 'Query embedding failed — keyword fallback');
      return this.keywordFallback(query, k, filter);
    }
    if (!Array.isArray(qvec) || qvec.length !== this.dim) {
      return this.keywordFallback(query, k, filter);
    }

    const scored: RetrievedTool[] = [];
    for (const [toolId, vec] of this.vectors) {
      const def = this.defs.get(toolId);
      if (!def) continue; // definition not registered yet
      if (filter && !passesFilter(def, filter)) continue;
      scored.push({ def, score: cosine(qvec, vec), source: 'vector' });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  private async keywordFallback(query: string, k: number, filter?: SearchFilter): Promise<RetrievedTool[]> {
    if (this.options.keywordSearch) {
      const defs = await this.options.keywordSearch(query, k, filter);
      return defs.map(def => ({ def, score: 0, source: 'keyword' as const }));
    }
    // Minimal internal scorer (token overlap) — last resort.
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const scored: RetrievedTool[] = [];
    for (const def of this.defs.values()) {
      if (filter && !passesFilter(def, filter)) continue;
      const hay = `${def.name} ${def.natural_language_description}`.toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      if (score > 0) scored.push({ def, score: score / tokens.length, source: 'keyword' });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  status(): VectorRegistryStatus {
    return {
      indexed: this.vectors.size,
      dimension: this.dim,
      mode: this.options.embedder && this.vectors.size > 0 ? 'vector' : 'keyword',
      vecExtension: this.vecAvailable,
      embedder: !!this.options.embedder,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function passesFilter(def: ToolDefinition, filter: SearchFilter): boolean {
  if (filter.connectorId && def.connector_id !== filter.connectorId) return false;
  if (filter.transport && def.transport !== filter.transport) return false;
  if (filter.schemaQuality && def.schema_quality !== filter.schemaQuality) return false;
  return true;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function floatsToBlob(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function blobToFloats(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}

/** FNV-1a 32-bit text hash (cache key — not security). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
