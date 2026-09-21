const path = require('path');
const os = require('os');
const fs = require('fs');

const { VectorMemory } = require('../dist/core/memory/VectorMemory.js');

function fakeEmbedSync(text) {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  const vec = new Array(384).fill(0);
  for (const w of words) {
    const key = w.replace(/[^a-z]/g, '');
    if (!key) continue;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i) - 97;
      if (c >= 0 && c < 26) vec[(c * 14 + i) % 384] += 1;
    }
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(v => v / norm);
}

const WORDS = 'invoice report spreadsheet email schedule meeting tax vat receipt refund client project deadline budget marketing seo google drive file folder archive delete rename copy paste dark theme editor code browser chrome edge desktop'.split(' ');

function randomDoc(i) {
  const parts = [];
  const n = 3 + (i % 8);
  for (let j = 0; j < n; j++) {
    parts.push(WORDS[(i * 7 + j * 13) % WORDS.length]);
  }
  return parts.join(' ');
}

async function main() {
  const dir = path.join(os.tmpdir(), `umbra-vecbench-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'bench.db');

  const mem = new VectorMemory(dbPath, { embed: fakeEmbedSync });
  mem.initialize();

  const COUNT = parseInt(process.env.COUNT || '5000', 10);
  const QUERIES = 200;

  console.log(`inserting ${COUNT} vectors...`);
  const t0 = Date.now();
  for (let i = 0; i < COUNT; i++) {
    await mem.addVector('bench', `doc-${i}`, randomDoc(i));
  }
  const insertMs = Date.now() - t0;
  console.log(`inserted ${COUNT} in ${insertMs}ms (${(insertMs / COUNT).toFixed(3)}ms/insert)`);

  console.log(`running ${QUERIES} similarity searches...`);
  const queryVecs = [];
  for (let q = 0; q < QUERIES; q++) {
    queryVecs.push(fakeEmbedSync(randomDoc(q * 31)));
  }

  const latencies = [];
  for (let q = 0; q < QUERIES; q++) {
    const s = process.hrtime.bigint();
    const results = await mem.searchSimilar(queryVecs[q], { k: 10, kind: 'bench' });
    const tookMs = Number(process.hrtime.bigint() - s) / 1e6;
    latencies.push(tookMs);
    if (q === 0) {
      console.log('sample top result:', results[0]?.refId, 'dist', results[0]?.distance?.toFixed(4));
    }
  }

  const embLatencies = [];
  for (let q = 0; q < QUERIES; q++) {
    const s = process.hrtime.bigint();
    await mem.searchSimilar(randomDoc(q * 31), { k: 10, kind: 'bench' });
    const tookMs = Number(process.hrtime.bigint() - s) / 1e6;
    embLatencies.push(tookMs);
  }
  embLatencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const max = latencies[latencies.length - 1];

  console.log('\n== Pure KNN retrieval latency (query pre-embedded) ==');
  console.log(`  avg : ${avg.toFixed(3)} ms`);
  console.log(`  p50 : ${p50.toFixed(3)} ms`);
  console.log(`  p95 : ${p95.toFixed(3)} ms`);
  console.log(`  max : ${max.toFixed(3)} ms`);

  const e50 = embLatencies[Math.floor(embLatencies.length * 0.5)];
  const e95 = embLatencies[Math.floor(embLatencies.length * 0.95)];
  console.log('\n== End-to-end search (embed + KNN) ==');
  console.log(`  p50 : ${e50.toFixed(3)} ms`);
  console.log(`  p95 : ${e95.toFixed(3)} ms`);
  console.log(`  vec engine: ${mem.getVecStats().available ? 'sqlite-vec' : 'fallback'}`);
  console.log(`  vector count: ${mem.getVecStats().vectors}`);

  const target = 15;
  const pass = p95 <= target;
  console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'} (pure KNN p95 target < ${target}ms)`);

  mem.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
