/**
 * ingest-connector-specs — bulk spec ingestion for catalog connectors.
 *
 * Walks every catalog entry that has an OpenAPI/Swagger spec, fetches it,
 * converts it to ToolDefinitions via ToolIngestion, derives the baseUrl, and
 * caches the result. This is what turns name-only catalog rows into callable
 * connectors.
 *
 * Resumable: progress is written to `spec-cache.json` after every batch, so an
 * interrupted run continues where it stopped rather than refetching.
 *
 * Usage:
 *   npx ts-node scripts/ingest-connector-specs.ts [--limit N] [--concurrency N] [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolIngestion } from '../src/core/mcp/ToolIngestion';
import { MCP_CATALOG, findCatalogEntry } from '../src/core/mcp/McpCatalog';
import { curatedConnectorForCatalogId } from '../src/core/mcp/curatedTools';
import { getLogger } from '../src/core/Logger';

const APISGURU_LIST = 'https://api.apis.guru/v2/list.json';
const CACHE_PATH = path.resolve(__dirname, '../.spec-cache.json');

/**
 * MUST match the runtime ingestion DB, or the indexed tools are invisible to
 * the executor. index.ts wires `new ToolIngestion(path.join(config.paths.dataDir,
 * 'connectors.db'))` and ConfigManager defaults dataDir to `~/.umbra`.
 */
function runtimeDbPath(): string {
  const dataDir = process.env.UMBRA_DATA_DIR
    || path.join(process.env.USERPROFILE || '~', '.umbra');
  return path.join(dataDir, 'connectors.db');
}
const DB_PATH = runtimeDbPath();

// ── args ────────────────────────────────────────────────────────────
function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const LIMIT = arg('limit', 0);
const CONCURRENCY = Math.max(1, arg('concurrency', 6));
const DRY_RUN = process.argv.includes('--dry-run');
/** Drop previously-ingested definitions first, so specs that are now rejected
 *  (e.g. relative-only servers) don't linger as unroutable rows. */
const CLEAN = process.argv.includes('--clean');

// ── cache ───────────────────────────────────────────────────────────
interface CacheEntry { specUrl: string; baseUrl?: string; tools?: number; error?: string; }
type Cache = Record<string, CacheEntry>;

function loadCache(): Cache {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(cache: Cache): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ── APIs.guru index ─────────────────────────────────────────────────
interface GuruEntry { preferred: string; versions: Record<string, { specUrl?: string; swaggerUrl?: string; info?: any }>; }

/**
 * Build `apisguru-<slug>` → specUrl from the live APIs.guru index. The catalog
 * already contains these entries; this supplies the spec URLs that the last
 * sync dropped on the floor.
 */
async function buildSpecIndex(): Promise<Map<string, string>> {
  getLogger().info('Fetching APIs.guru index...');
  const res = await fetch(APISGURU_LIST, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`APIs.guru list failed: HTTP ${res.status}`);
  const list = (await res.json()) as Record<string, GuruEntry>;

  const index = new Map<string, string>();
  for (const [provider, data] of Object.entries(list)) {
    const version = data.versions?.[data.preferred] ?? Object.values(data.versions ?? {})[0];
    const url = version?.specUrl ?? version?.swaggerUrl;
    if (!url) continue;
    // Catalog ids are `apisguru-<slug(providerKey)>`.
    index.set(`apisguru-${slug(provider)}`, url);
  }
  getLogger().info({ count: index.size }, 'APIs.guru index built');
  return index;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Fallback purge when ToolIngestion exposes no LIKE delete. */
function purgeViaSql(ingestion: any, pattern: string): number {
  const db = (ingestion as any).db;
  if (!db) return 0;
  const info = db.prepare('DELETE FROM tool_definitions WHERE connector_id LIKE ?').run(pattern);
  return info.changes ?? 0;
}

/**
 * Derive an ABSOLUTE baseUrl from a spec.
 *
 * Some specs declare `servers: [{ url: '/api/v1' }]` — a relative path. The
 * executor concatenates `${base_url}${endpoint_template}`, so a relative base
 * yields an unroutable URL. Those are rejected here rather than stored, and
 * the spec is treated as unusable instead of silently broken.
 */
function deriveBaseUrl(spec: any): string | undefined {
  const isAbsolute = (u: string) => /^https?:\/\/[^\s]+$/i.test(u);

  const servers = spec?.servers;
  const first = Array.isArray(servers) ? servers[0] : undefined;
  const url = typeof first === 'string' ? first : first?.url;
  if (typeof url === 'string' && isAbsolute(url.trim())) return url.trim();

  // Relative server URL + Swagger 2.0 host → build an absolute origin.
  if (spec?.host) {
    const scheme = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes[0] : 'https';
    const built = `${scheme}://${spec.host}${spec.basePath ?? ''}`;
    if (isAbsolute(built)) return built;
  }

  // Relative server URL paired with a `schemes`/`host` absent spec: try the
  // provider's own domain from x-providerName / info.contact if present.
  const contact = spec?.info?.contact?.url;
  if (typeof contact === 'string' && isAbsolute(contact)) {
    try { return new URL(contact).origin; } catch { /* fall through */ }
  }

  return undefined;
}

// ── main ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const cache = loadCache();
  const ingestion = new ToolIngestion(DB_PATH);

  if (CLEAN) {
    // Ingestion is an upsert, so a spec that becomes un-ingestable would keep
    // its old rows. Purge generated definitions before a full re-run.
    const purged = ingestion.deleteForConnectorLike?.('apisguru-%')
      ?? purgeViaSql(ingestion, 'apisguru-%');
    console.log(`Purged ${purged} previously-ingested definitions.`);
  }

  const specIndex = await buildSpecIndex();

  // Candidates: anything not already covered by curated tools.
  const candidates = MCP_CATALOG.filter(c => {
    if (curatedConnectorForCatalogId(c.id)) return false;
    const specUrl = cache[c.id]?.specUrl ?? specIndex.get(c.id);
    if (!specUrl) return false;
    return !cache[c.id]?.error;
  }).slice(0, LIMIT || undefined);

  getLogger().info({ candidates: candidates.length, concurrency: CONCURRENCY }, 'Ingestion starting');
  console.log(`\nCandidates with specs: ${candidates.length}`);
  if (DRY_RUN) {
    console.log('(dry run — not fetching)');
    console.log(candidates.slice(0, 10).map(c => `  ${c.id}`).join('\n'));
    return;
  }

  const stats = { ok: 0, failed: 0, tools: 0, skipped: 0 };
  let done = 0;

  // Simple concurrency pool — no dependency needed.
  const queue = [...candidates];
  async function worker(): Promise<void> {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        const specUrl = cache[entry.id]?.specUrl ?? specIndex.get(entry.id)!;
        const res = await fetch(specUrl, { signal: AbortSignal.timeout(45_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const spec = await res.json();

        const baseUrl = deriveBaseUrl(spec) || undefined;
        if (!baseUrl) throw new Error('no absolute base URL in spec');
        const authType = (entry.authType === 'oauth' || entry.authType === 'bearer' || entry.authType === 'apiKey')
          ? entry.authType : undefined;
        const count = ingestion.ingestOpenApi(entry.id, spec, {
          baseUrl, authType, apiKeyHeader: entry.apiKeyHeader,
          category: entry.category, maxTools: 60,
        });

        if (count === 0) throw new Error('no REST operations');
        cache[entry.id] = { specUrl, baseUrl, tools: count };
        stats.ok++; stats.tools += count;
      } catch (err) {
        cache[entry.id] = { specUrl: cache[entry.id]?.specUrl ?? specIndex.get(entry.id)!, error: (err as Error).message.slice(0, 120) };
        stats.failed++;
      }
      done++;
      if (done % 25 === 0) {
        saveCache(cache);
        console.log(`  ${done}/${candidates.length}  ok=${stats.ok} failed=${stats.failed} tools=${stats.tools}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveCache(cache);

  console.log(`\n══ Ingestion complete ══`);
  console.log(`  processed:  ${done}`);
  console.log(`  succeeded:  ${stats.ok}  (${stats.tools} tools)`);
  console.log(`  failed:     ${stats.failed}`);
  console.log(`  cache:      ${CACHE_PATH}`);
}

main().catch(err => { console.error('Ingestion failed:', err.message); process.exit(1); });
