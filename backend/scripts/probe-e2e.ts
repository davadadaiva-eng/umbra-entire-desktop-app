/**
 * probe-e2e.ts — Live end-to-end probe of the connector tool framework.
 *
 *   1. INGEST   — ToolIngestion.ingestOpenApi() on the real Petstore 3.0.4
 *                 spec (downloaded from petstore3.swagger.io).
 *   2. RETRIEVE — VectorToolRegistry.search() for a natural-language prompt
 *                 (semantic mode when an embedder is reachable, keyword
 *                 fallback otherwise — both must return relevant tools).
 *   3. EXECUTE  — ToolExecutor.executeTool() (schema-validated REST) against
 *                 the ingested pet tool (arg validation BEFORE HTTP), plus
 *                 one live validated call on the connected wikipedia
 *                 connector via the curated definition.
 *
 * Run:  cd backend && npx ts-node scripts/probe-e2e.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ToolIngestion } from '../src/core/mcp/ToolIngestion';
import { VectorToolRegistry } from '../src/core/mcp/VectorToolRegistry';
import { ToolExecutor } from '../src/core/mcp/ToolExecutor';
import { ConnectorStore } from '../src/core/mcp/ConnectorStore';
import { ToolDefinition, validateToolArgs } from '../src/core/mcp/ToolDefinition';

const dataDir = path.join(os.homedir(), '.umbra');
const connectorsDb = path.join(dataDir, 'connectors.db');
const vectorsDb = path.join(dataDir, 'tool-vectors.db');

const section = (title: string) =>
  console.log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`);

async function main(): Promise<void> {
  // ── 1. INGEST a real OpenAPI spec ──────────────────────────────────
  section('1. INGEST — OpenAPI 3.0 (Petstore 3.0.4, live-fetched spec)');
  const specPath = path.join(__dirname, 'petstore-openapi.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  console.log(`spec: "${spec.info?.title}" openapi ${spec.openapi}, ${Object.keys(spec.paths ?? {}).length} paths`);

  const ingestion = new ToolIngestion(connectorsDb);
  // Server boot order: curated set first, then spec ingestion on top.
  ingestion.loadCurated();
  const ingested = ingestion.ingestOpenApi('petstore-demo', spec, {
    baseUrl: 'https://petstore3.swagger.io/api/v3',
    category: 'Demo',
  });
  const totalDefs = ingestion.count();
  const petDefs = ingestion.getForConnector('petstore-demo');
  const addPet = petDefs.find(d => d.name === 'add_pet');
  const findPets = petDefs.find(d => d.name === 'find_pets_by_status');
  console.log(`ingested: ${ingested} tools from petstore-demo (total definitions in db: ${totalDefs})`);
  console.log(`sample defs: ${petDefs.slice(0, 4).map(d => `${d.tool_id} [${d.http_method} ${d.endpoint_template}]`).join(' | ')}`);
  if (!addPet || !findPets) throw new Error('expected add_pet / find_pets_by_status definitions — ingestion failed');

  // Show that a nested requestBody was flattened into top-level properties.
  console.log(`add_pet params: {${Object.keys(addPet.parameters_schema.properties ?? {}).join(', ')}} required=[${(addPet.parameters_schema.required ?? []).join(', ')}]`);

  // ── 2. RETRIEVE tools for a natural-language prompt ───────────────
  section('2. RETRIEVE — semantic (or keyword) tool search for a prompt');
  const registry = new VectorToolRegistry(vectorsDb);
  registry.registerDefinitions(ingestion.listAll());
  // No embedder configured → exercise the keyword fallback ladder here.
  // (The live server /api/status shows which mode the booted stack is in.)
  const t0 = Date.now();
  const hits = await registry.search('adopt a new pet and add it to the store', 5);
  const dt = Date.now() - t0;
  console.log(`search took ${dt}ms, mode=${registry.status().mode}, top ${hits.length}:`);
  for (const h of hits) {
    console.log(`  ${(h.score).toFixed(3)}  ${h.def.tool_id.padEnd(40)} ${h.source}`);
  }
  if (!hits.some(h => h.def.connector_id === 'petstore-demo')) {
    throw new Error('retrieval returned no petstore-demo tools for a pet prompt');
  }

  // ── 3a. EXECUTE — schema validation gate (no HTTP leaves on bad args) ──
  section('3a. EXECUTE — validation gate rejects bad args BEFORE HTTP');
  const badArgs = { name: 42, photoUrls: 'not-an-array', status: 'unknown-enum' };
  const pre = validateToolArgs(badArgs, findPets.parameters_schema);
  console.log(`validateToolArgs(bad args) → ok=${pre.ok} errors=${JSON.stringify(pre.errors)}`);
  if (pre.ok) throw new Error('validation gate let bad args through');

  const store = new ConnectorStore(connectorsDb);
  const executor = new ToolExecutor(store, { maxAttempts: 2 });

  const gate = await executor.executeTool(findPets, badArgs, 'default');
  console.log(`executeTool with bad args → success=${gate.success} status=${gate.status} (no HTTP: latency=${gate.latencyMs}ms)`);
  console.log(`  error: ${gate.error}`);
  if (gate.success || (gate.validationErrors ?? []).length === 0) {
    throw new Error('expected validationErrors on the executor result');
  }

  // ── 3b. EXECUTE — live schema-validated call (ingested pet tool) ────
  section('3b. EXECUTE — live GET /pet/findByStatus (ingested tool, validated)');
  const live = await executor.executeTool(
    findPets,
    { status: 'available' },
    'default',
    { timeoutMs: 20_000 },
  );
  const arr = Array.isArray(live.data) ? (live.data as unknown[]) : [];
  const pet0 = arr.length > 0 ? (arr[0] as Record<string, unknown>) : undefined;
  console.log(`executeTool(${findPets.tool_id}, {status:'available'}) → success=${live.success} HTTP ${live.status} in ${live.latencyMs}ms (attempts=${live.attempts})`);
  console.log(`  response: ${arr.length} pets; first = ${pet0 ? JSON.stringify({ id: pet0.id, name: pet0.name, status: pet0.status }) : '(empty)'}`);
  if (!live.success) throw new Error(`live petstore call failed: ${live.error}`);

  // ── 3c. EXECUTE — connected connector via curated definition ───────
  section('3c. EXECUTE — curated wikipedia tool (real connected connector)');
  const wiki = ingestion.listAll().find(d => d.tool_id === 'curated-wikipedia.wikipedia_search');
  if (!wiki) throw new Error('curated wikipedia tool not found — loadCurated did not run here');
  // First attempt with hallucinated arg names — the gate must reject it with
  // feedable errors, exactly as it would an LLM that guessed wrong.
  const wikiBad = await executor.executeTool(wiki, { query: 'large language model', limit: 3 }, 'default');
  console.log(`first attempt (wrong args) → success=${wikiBad.success}, ${wikiBad.validationErrors?.length ?? 0} validation errors`);
  if (wikiBad.success || (wikiBad.validationErrors ?? []).length === 0) throw new Error('validation gate did not reject wrong args');

  // Corrective retry (what the agent loop feeds back to the LLM for).
  const wikiArgs = { action: 'query', list: 'search', srsearch: 'large language model', format: 'json', srlimit: 3 };
  const wikiCheck = validateToolArgs(wikiArgs, wiki.parameters_schema);
  console.log(`corrected args → validateToolArgs ok=${wikiCheck.ok}${wikiCheck.ok ? '' : ` errors=${JSON.stringify(wikiCheck.errors)}`}`);
  const wikiRes = await executor.executeTool(wiki, wikiArgs, 'default', { timeoutMs: 20_000 });
  const results = (wikiRes.data as any)?.query?.search;
  console.log(`executeTool(${wiki.tool_id}) → success=${wikiRes.success} HTTP ${wikiRes.status} in ${wikiRes.latencyMs}ms`);
  console.log(`  results: ${(results ?? []).map((r: any) => `"${r.title}"`).join(', ')}`);
  if (!wikiRes.success) throw new Error(`wikipedia curated call failed: ${wikiRes.error}`);

  // ── Summary ─────────────────────────────────────────────────────────
  section('PROBE PASSED');
  console.log(`ingest   : +${ingested} OpenAPI tools (db total ${totalDefs})`);
  console.log(`retrieve : ${hits.length} tools in ${dt}ms (mode=${registry.status().mode})`);
  console.log(`validate : bad args rejected pre-HTTP with ${gate.validationErrors?.length} feedable errors`);
  console.log(`execute  : petstore HTTP ${live.status} (${arr.length} pets), wikipedia HTTP ${wikiRes.status} (${(results ?? []).length} hits)`);

  ingestion.close();
  registry.close();
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`\n✗ PROBE FAILED: ${err?.stack || err}`);
  process.exit(1);
});
