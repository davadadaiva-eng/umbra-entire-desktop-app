/**
 * persist-spec-results — writes ingestion results back into the catalog.
 *
 * The ingestion run derives a real `baseUrl` (and a `specUrl`) for connectors
 * that shipped as name-only rows. This merges those back into
 * ExternalCatalog.json so discovery, readiness, and the executor all see the
 * same truth instead of an empty baseUrl.
 *
 * Safe to re-run: only fills fields that are currently empty.
 *
 * Usage: npx ts-node scripts/persist-spec-results.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const CATALOG = path.resolve(__dirname, '../src/core/mcp/ExternalCatalog.json');
const CACHE = path.resolve(__dirname, '../.spec-cache.json');

interface CacheEntry { specUrl: string; baseUrl?: string; tools?: number; error?: string; }

function main(): void {
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Record<string, CacheEntry>;
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8')) as any[];

  let baseUrlFilled = 0;
  let specUrlFilled = 0;
  let toolCount = 0;
  let matched = 0;

  for (const entry of catalog) {
    const hit = cache[entry.id];
    if (!hit || hit.error) continue;
    matched++;
    toolCount += hit.tools ?? 0;
    if (!entry.baseUrl && hit.baseUrl) { entry.baseUrl = hit.baseUrl; baseUrlFilled++; }
    if (!entry.specUrl && hit.specUrl) { entry.specUrl = hit.specUrl; specUrlFilled++; }
  }

  fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2));

  console.log('══ Catalog updated ══');
  console.log(`  catalog entries:      ${catalog.length}`);
  console.log(`  matched to a spec:    ${matched}`);
  console.log(`  baseUrl filled:       ${baseUrlFilled}`);
  console.log(`  specUrl filled:       ${specUrlFilled}`);
  console.log(`  tools now callable:   ${toolCount}`);
  const stillEmpty = catalog.filter(c => !c.baseUrl || !c.baseUrl.trim()).length;
  console.log(`  still no baseUrl:     ${stillEmpty}`);
}

main();
