#!/usr/bin/env node
/**
 * benchmark.js — scripted browser-agent benchmark harness.
 *
 * Drives the agent loop over a fixture manifest (search, fill form, extract
 * data) through the REST API and reports pass/fail per fixture, wall-clock
 * time, and token cost. Pass/fail comes from deterministic expected-keyword
 * matching against the task answer — no external LLM dependency, so runs are
 * reproducible.
 *
 * Usage:
 *   node scripts/benchmark.js                     # connects to http://127.0.0.1:8787
 *   node scripts/benchmark.js --api http://host:8787
 *   node scripts/benchmark.js --fixtures ./my-manifest.json
 *   node scripts/benchmark.js --timeout 300000 --verbose
 *
 * Fixture shape:
 *   { "id": "search-1", "task": "Search for ...", "expect": ["keyword1", "regexp"], "note": "optional" }
 *   `expect` is an array of substrings OR /regex/ literals; ALL must match the
 *   task answer (result.summary + result.output) for a pass.
 *
 * Exits 0 when all fixtures pass, 1 when any fail or the run errored — so it
 * can gate CI or a "before/after parallel execution" comparison.
 */

const DEFAULT_FIXTURES = [
  {
    id: 'search-known-fact',
    task: 'Search the web and tell me the capital of France.',
    expect: ['Paris'],
    note: 'basic search + read-back',
  },
  {
    id: 'search-weather-capital',
    task: 'Search for the current weather in London and report the city name and the temperature in a single sentence.',
    expect: ['London'],
    note: 'search with extraction',
  },
  {
    id: 'extract-from-page',
    task: 'Open https://example.com and tell me the heading text on the page.',
    expect: ['Example Domain'],
    note: 'navigate + DOM extract',
  },
  {
    id: 'aggregate-two-sources',
    task: 'Look up the populations of Spain and Italy, then say which is larger.',
    expect: ['Spain', 'Italy'],
    note: 'multi-step aggregation (parallelism candidate)',
  },
];

const API = process.argv.indexOf('--api') !== -1
  ? process.argv[process.argv.indexOf('--api') + 1]
  : process.env.UMBRA_BENCH_API || 'http://127.0.0.1:8787';

const FIXTURES_FILE = process.argv.indexOf('--fixtures') !== -1
  ? process.argv[process.argv.indexOf('--fixtures') + 1]
  : process.env.UMBRA_BENCH_FIXTURES || '';

const TASK_TIMEOUT_MS = Number(process.argv.indexOf('--timeout') !== -1
  ? process.argv[process.argv.indexOf('--timeout') + 1]
  : process.env.UMBRA_BENCH_TIMEOUT_MS || 300000);

const VERBOSE = process.argv.includes('--verbose') || process.env.UMBRA_BENCH_VERBOSE === '1';


const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, method = 'GET', body) {
  const res = await fetch(API + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function loadFixtures() {
  if (!FIXTURES_FILE) return DEFAULT_FIXTURES;
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(path.resolve(FIXTURES_FILE), 'utf-8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.fixtures;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('fixtures file must be an array (or { fixtures: [...] }) with at least one entry');
  }
  return list;
}

/** All `expect` entries (strings or /regex/) must match the answer text. */
function verify(answer, expect) {
  const hits = [];
  const misses = [];
  for (const e of expect || []) {
    if (e instanceof RegExp) {
      if (e.test(answer)) hits.push(String(e)); else misses.push(String(e));
    } else {
      if (answer.toLowerCase().includes(String(e).toLowerCase())) hits.push(String(e));
      else misses.push(String(e));
    }
  }
  return { pass: misses.length === 0, hits, misses };
}

async function runFixture(fx) {
  const started = Date.now();
  const submitted = await api('/api/task', 'POST', { description: fx.task, priority: 1 });
  if (submitted.status !== 200 || !submitted.json.taskId) {
    return { fx, ok: false, error: `submit failed: ${JSON.stringify(submitted.json).slice(0, 300)}`, durationMs: Date.now() - started, tokens: 0 };
  }
  const taskId = submitted.json.taskId;

  let final = null;
  while (Date.now() - started < TASK_TIMEOUT_MS) {
    const t = await api('/api/task/' + taskId);
    const task = t.json.task;
    if (!task) { await sleep(1000); continue; }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) { final = task; break; }
    await sleep(2000);
  }
  const durationMs = Date.now() - started;
  if (!final) {
    return { fx, ok: false, error: `timeout after ${Math.round(TASK_TIMEOUT_MS / 1000)}s (status: pending)`, durationMs, tokens: 0 };
  }
  if (final.status !== 'completed') {
    return { fx, ok: false, error: `status=${final.status}${final.error ? ' — ' + final.error : ''}`, durationMs, tokens: 0 };
  }

  const summary = String(final.result && final.result.summary || '');
  const output = final.result && final.result.output !== undefined
    ? (typeof final.result.output === 'string' ? final.result.output : JSON.stringify(final.result.output))
    : '';
  const answer = (summary + '\n' + output).trim();

  const verdict = verify(answer, fx.expect);
  return { fx, ok: verdict.pass, verdict, durationMs, tokens: final.totalTokens || 0, answer: answer.slice(0, 400) };
}

async function main() {
  const fixtures = loadFixtures();
  console.log(`\n=== Umbra agent benchmark ===`);
  console.log(`API:      ${API}`);
  console.log(`Fixtures: ${fixtures.length}  (timeout ${Math.round(TASK_TIMEOUT_MS / 1000)}s each)`);
  console.log(`Verifier: expected-keyword match\n`);

  // Sanity: the agent API must be reachable before spending time on tasks.
  try {
    const health = await api('/api/health');
    if (health.status !== 200) throw new Error('bad status ' + health.status);
  } catch (e) {
    console.error(`FATAL: agent API not reachable at ${API} — start Umbra first (or pass --api). (${e.message})`);
    process.exit(2);
  }

  const results = [];
  let passCount = 0;
  for (const fx of fixtures) {
    process.stdout.write(`[${fx.id}] ${fx.task.slice(0, 60)}... `);
    const r = await runFixture(fx);
    results.push(r);
    if (r.ok) passCount++;
    const icon = r.ok ? 'PASS' : 'FAIL';
    console.log(`${icon} (${(r.durationMs / 1000).toFixed(1)}s${r.tokens ? `, ${r.tokens} tokens` : ''})`);
    if (!r.ok) console.log(`       ${r.error || ''}`);
    if (VERBOSE && r.answer) console.log(`       answer: ${r.answer.replace(/\n/g, ' ').slice(0, 160)}`);
  }

  // Summary table.
  console.log('\n=== Summary ===');
  console.log('fixture'.padEnd(22) + 'result'.padEnd(8) + 'time(s)'.padEnd(9) + 'tokens');
  for (const r of results) {
    console.log(
      String(r.fx.id).padEnd(22)
      + (r.ok ? 'PASS' : 'FAIL').padEnd(8)
      + (r.durationMs / 1000).toFixed(1).padEnd(9)
      + (r.tokens || 0),
    );
  }
  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
  const totalTokens = results.reduce((a, r) => a + (r.tokens || 0), 0);
  console.log(`\n${passCount}/${fixtures.length} passed · total wall-clock ${(totalMs / 1000).toFixed(1)}s · ${totalTokens} tokens`);

  // Optional token-usage snapshot from the plan endpoints.
  try {
    const usage = await api('/api/plan/usage');
    if (usage.status === 200) console.log('plan usage:', JSON.stringify(usage.json));
  } catch { }

  process.exit(passCount === fixtures.length ? 0 : 1);
}

main().catch(e => { console.error('\nFATAL: ' + e.message); process.exit(1); });
