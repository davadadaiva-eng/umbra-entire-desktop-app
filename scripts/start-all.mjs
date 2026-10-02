#!/usr/bin/env node
/**
 * start-all.mjs — boot the local voice stack + backend with one command.
 *
 *   node scripts/start-all.mjs            # STT + TTS + backend
 *   node scripts/start-all.mjs --no-stt   # skip the STT server
 *   node scripts/start-all.mjs --no-tts   # skip the TTS server
 *   node scripts/start-all.mjs --no-voice # skip both voice servers
 *
 * Why not `concurrently`? The voice servers are long-running Python processes;
 * on Windows, concurrently -k cannot reliably tree-kill a spawned python.exe
 * when the wrapper exits, leaving orphaned listeners on 17510/17520. This
 * script owns each process (detached + tree-kill on exit/SIGINT) and waits for
 * every /health endpoint before moving on, so `npm run start:all` comes up
 * ready instead of racing.
 *
 * The backend runs in DESKTOP mode on purpose: UMBRA_HEADLESS=1 skips the
 * whole voice subsystem (voiceStack, meeting companion, push-to-talk), which
 * defeats the point of this script.
 */

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..', 'backend');
const HOST = '127.0.0.1';

const args = new Set(process.argv.slice(2));
const SKIP_STT = args.has('--no-stt') || args.has('--no-voice');
const SKIP_TTS = args.has('--no-tts') || args.has('--no-voice');
const FAST = args.has('--fast'); // shorter health waits

const STT_URL = `http://${HOST}:17510/health`;
const TTS_URL = `http://${HOST}:17520/health`;
const API_URL = `http://${HOST}:8787/api/health`;
const HEALTH_TIMEOUT_MS = FAST ? 10_000 : 60_000;
const STT_LOAD_TIMEOUT_MS = FAST ? 10_000 : 120_000; // first boot may download the model
// The backend boots Desktop2 (spawns Chrome), the P2P layer and a 4k-entry MCP
// registry — cold starts can legitimately exceed a minute.
const BACKEND_HEALTH_TIMEOUT_MS = FAST ? 20_000 : 240_000;
const POLL_MS = 500;

const procs = [];
let shuttingDown = false;

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  ok: s => `\x1b[32m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`,
  err: s => `\x1b[31m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

function log(icon, msg) {
  const t = new Date().toISOString().slice(11, 19);
  process.stdout.write(`${c.dim(t)} ${icon}  ${msg}\n`);
}

/** Resolve the Python launcher: the .sh wrappers assume `python3`, which does
 *  not exist on Windows (the Store alias intercepts it). Prefer `python`. */
function resolvePython() {
  for (const cmd of ['python', 'python3']) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

/** GET a health endpoint; resolve { ok, body } once it answers 200. */
function probe(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 2000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: data.slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: 'timeout' }); });
    req.on('error', () => resolve({ ok: false, body: 'unreachable' }));
  });
}

/** Poll a health endpoint until ok or timeout. Returns the last body. */
async function waitForHealth(url, { timeoutMs, label, stateKey = 'state', readyState = 'ready' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const r = await probe(url);
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        if (j[stateKey] === 'error') throw new Error(String(j.error || 'reported error'));
        if (j[stateKey] === readyState || j[stateKey] === undefined) return j;
        last = `${stateKey}=${j[stateKey]}`;
      } catch (e) {
        if (e.message && e.message !== 'Unexpected token') throw e; // JSON parse fail = still warming up
        last = r.body;
      }
    } else {
      last = r.body;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`${label} not healthy after ${Math.round(timeoutMs / 1000)}s (${last})`);
}

/** Is something already listening on this port? */
function portBusy(port) {
  try {
    const out = execSync(`netstat -ano | grep -E ":${port}\\s.*LISTENING"`, { shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim().length > 0;
  } catch { return false; }
}

/** Start a child, tag its output, remember it for teardown. */
function startService({ name, cmd, cmdArgs, cwd, color, onLine }) {
  const child = spawn(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  procs.push({ name, child });
  const wire = stream => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) onLine ? onLine(line) : log(color, `${name}: ${line}`);
      }
    });
  };
  wire(child.stdout);
  wire(child.stderr);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) log(c.err('✖'), `${name} exited unexpectedly (code=${code}${signal ? ` signal=${signal}` : ''})`);
  });
  return child;
}

/** Kill a child and, on Windows, its whole tree (python spawns can nest). */
function killTree(child) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); return; } catch { /* fall through */ }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(c.warn('⏹'), 'Shutting down — stopping every service this script started…');
  for (const { name, child } of procs) {
    log(c.dim('·'), `stopping ${name} (pid ${child.pid})`);
    killTree(child);
  }
  // Give Windows a beat to release the listeners before the ports are re-checked.
  await new Promise(r => setTimeout(r, 500));
  log(c.dim('·'), 'done — bye');
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('exit', () => { for (const { child } of procs) killTree(child); });

// ── Preflight ────────────────────────────────────────────────────────────
console.log(`\n${c.cyan('Umbra OS — local stack')}${c.dim('  (STT + TTS + backend)')}\n`);

const PORT_CONFLICTS = [
  ['backend', 8787, API_URL],
  ['STT', 17510, STT_URL],
  ['TTS', 17520, TTS_URL],
];
for (const [name, port, url] of PORT_CONFLICTS) {
  if (portBusy(port)) {
    const r = await probe(url);
    log(c.err('✖'), `${name} port ${port} is already in use. Stop the existing process first (it ${r.ok ? 'answers health checks — likely a previous run' : 'did not answer health checks'}).`);
    process.exit(1);
  }
}

const backendEntry = path.join(BACKEND_DIR, 'dist', 'index.js');
if (!SKIP_STT || !SKIP_TTS) {
  // Only needed when at least one Python voice server is requested.
  if (!resolvePython()) {
    log(c.err('✖'), 'Python not found (tried `python`, `python3`). Install Python 3.10+ or pass --no-voice.');
    process.exit(1);
  }
}

// ── STT (faster-whisper) ─────────────────────────────────────────────────
if (!SKIP_STT) {
  const python = resolvePython();
  log(c.dim('▶'), 'starting faster-whisper STT (port 17510)…');
  startService({
    name: 'stt',
    cmd: python,
    cmdArgs: [path.join(BACKEND_DIR, 'scripts', 'faster-whisper-stt-server.py')],
    cwd: BACKEND_DIR,
    color: c.cyan('·'),
    onLine: line => { if (!/INFO:|DeprecationWarning|@app\.on_event|^\s*$|Read more about it/i.test(line)) log(c.cyan('stt'), line); },
  });
  try {
    const h = await waitForHealth(STT_URL, { timeoutMs: STT_LOAD_TIMEOUT_MS, label: 'STT' });
    log(c.ok('✔'), `STT ready — model ${h.model} (${h.device}), language ${h.language}`);
  } catch (e) {
    log(c.err('✖'), e.message);
    await shutdown(1);
  }
} else {
  log(c.warn('–'), 'STT skipped (--no-voice/--no-stt)');
}

// ── TTS (piper) ──────────────────────────────────────────────────────────
if (!SKIP_TTS) {
  const python = resolvePython();
  log(c.dim('▶'), 'starting piper TTS (port 17520)…');
  startService({
    name: 'tts',
    cmd: python,
    cmdArgs: [path.join(BACKEND_DIR, 'scripts', 'piper-tts-server.py')],
    cwd: BACKEND_DIR,
    color: c.cyan('·'),
    onLine: line => { if (!/INFO:|DeprecationWarning|@app\.on_event|^\s*$|Read more about it/i.test(line)) log(c.cyan('tts'), line); },
  });
  try {
    const h = await waitForHealth(TTS_URL, { timeoutMs: HEALTH_TIMEOUT_MS, label: 'TTS' });
    log(c.ok('✔'), `TTS ready — voice ${h.voice}`);
  } catch (e) {
    log(c.err('✖'), e.message);
    await shutdown(1);
  }
} else {
  log(c.warn('–'), 'TTS skipped (--no-voice/--no-tts)');
}

// ── Backend (desktop mode — headless skips the voice subsystem!) ─────────
if (!portBusy(8787)) {
  log(c.dim('▶'), 'starting Umbra backend (port 8787, desktop mode)…');
  startService({
    name: 'backend',
    cmd: process.execPath,
    cmdArgs: [backendEntry],
    cwd: BACKEND_DIR,
    color: c.cyan('·'),
    onLine: line => { if (/ERROR|WARN|ready|initialized/i.test(line)) log(c.cyan('backend'), line); },
  });
  try {
    await waitForHealth(API_URL, { timeoutMs: BACKEND_HEALTH_TIMEOUT_MS, label: 'backend', stateKey: 'ok' });
    log(c.ok('✔'), 'Backend ready — http://127.0.0.1:8787');
  } catch (e) {
    log(c.err('✖'), e.message);
    await shutdown(1);
  }
} else {
  log(c.warn('–'), 'backend already running on 8787 — leaving it alone');
}

log(c.ok('◆'), `All services up. Hold ${c.ok('Ctrl+Shift+V')} to talk to Umbra. Ctrl+C stops everything.\n`);
// Keep the process alive so the children stay attached; children keep running.
setInterval(() => { /* heartbeat: nothing to do, just keep the event loop */ }, 60_000);
