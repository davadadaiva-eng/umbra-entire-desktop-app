#!/usr/bin/env node
/**
 * check-doc-counts.js — mechanical guard for documented test totals.
 *
 * description.txt and README.md advertise the jest suite/test counts, and
 * those numbers kept drifting because they were hand-synced every cycle.
 * This script runs the real jest suite (--json) and fails when any
 * documented count — or the stale "only red suite" note, which referenced a
 * CompanionRegistry failure that was fixed — no longer matches, so CI
 * catches the drift instead of contributors.
 *
 * Usage:
 *   node scripts/check-doc-counts.js
 *
 * Exits 0 when every documented count matches the real run, 1 when any is
 * stale, 2 when jest itself cannot run. Requires `npm install` (jest) — no
 * build needed.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = ['description.txt', 'README.md'];

function main() {
  const reportFile = path.join(ROOT, 'node_modules', '.cache', `jest-report-${process.pid}.json`);
  let json;
  const jestBin = require.resolve('jest/bin/jest');
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    const res = spawnSync(process.execPath, [jestBin, '--config', 'jest.config.js', '--json', '--outputFile', reportFile], {
      cwd: ROOT,
      timeout: 600000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, CI: 'true' },
    });
    // jest exits non-zero on test failures but --outputFile still writes the report.
    json = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (err) {
    try {
      json = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch { /* fall through */ }
    if (!json) {
      console.error('check-doc-counts: failed to run jest:', err.message);
      process.exit(2);
    }
  } finally {
    try { fs.unlinkSync(reportFile); } catch { /* best-effort */ }
  }

  const suites = json.numTotalTestSuites;
  const tests = json.numTotalTests;
  console.log(`check-doc-counts: jest reports ${suites} suites / ${tests} tests`);

  const problems = [];
  for (const doc of DOCS) {
    const lines = fs.readFileSync(path.join(ROOT, doc), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const pair = line.match(/(\d+)\s+tests?\s+(?:across|\/)\s+(\d+)\s+suites?/);
      if (pair && (Number(pair[1]) !== tests || Number(pair[2]) !== suites)) {
        problems.push(`${doc}:${i + 1}: documents ${pair[1]} tests / ${pair[2]} suites (actual ${tests} / ${suites}): ${line.trim()}`);
      }
      const today = line.match(/(\d+)\s+tests?\s+today/);
      if (today && Number(today[1]) !== tests) {
        problems.push(`${doc}:${i + 1}: documents ${today[1]} tests (actual ${tests}): ${line.trim()}`);
      }
      if (/only red|only failure|the only red/.test(line)) {
        problems.push(`${doc}:${i + 1}: still mentions a red/failing suite that no longer exists: ${line.trim()}`);
      }
    });
  }

  if (problems.length > 0) {
    console.error('check-doc-counts: FAILED — stale documentation counts:');
    for (const p of problems) console.error('  - ' + p);
    console.error('Run `npm test` and update the docs to match.');
    process.exit(1);
  }
  console.log('check-doc-counts: all documented counts match the real jest run.');
}

main();
