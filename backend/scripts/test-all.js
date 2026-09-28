const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const UMBRA_DIR = path.resolve(__dirname, '..');
const API = 'http://127.0.0.1:8787';

let failures = 0;
let passes = 0;
function check(label, cond, extra) {
  if (cond) { passes++; console.log('PASS: ' + label); }
  else { failures++; console.log('FAIL: ' + label + (extra ? ' — ' + extra : '')); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, method = 'GET', body) {
  const res = await fetch(API + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) };
}

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(API + '/api/health');
      if (res.status === 200) return true;
    } catch { }
    await sleep(1000);
  }
  return false;
}

async function main() {
  console.log('Starting Umbra OS...');
  const child = spawn('node', ['dist/index.js'], {
    cwd: UMBRA_DIR,
    env: { ...process.env, UMBRA_ENGINE: 'desktop2', UMBRA_HEADLESS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', d => {
    const text = d.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', d => process.stderr.write(d));

  try {
    console.log('\n=== Waiting for API ===');
    const apiReady = await waitForApi(60000);
    check('API boots within 60s', apiReady);
    if (!apiReady) { console.log('API not ready, exiting'); process.exit(1); }

    // === Health ===
    const health = await api('/api/health');
    check('health endpoint returns 200', health.status === 200);
    check('health.ok is true', health.json.ok === true);

    // === Status ===
    const status = await api('/api/status');
    check('status endpoint returns 200', status.status === 200);
    check('status.initialized', status.json.initialized === true);
    check('status has consent', status.json.consent && typeof status.json.consent === 'object');
    check('status has desktop2', status.json.desktop2 && typeof status.json.desktop2 === 'object');
    // Streamer only exists in non-headless mode
    if (!status.json.streamer) {
      console.log('NOTE: streamer not available (headless mode)');
    }

    // === Consent ===
    const consent = await api('/api/consent');
    check('consent GET returns 200', consent.status === 200);
    check('consent has emergencyStopArmed', typeof consent.json.emergencyStopArmed === 'boolean');

    // === Task submission ===
    const task = await api('/api/task', 'POST', { description: 'Test task: say hello', priority: 1 });
    check('task submit returns 200', task.status === 200);
    check('task has taskId', !!task.json.taskId);
    const taskId = task.json.taskId;

    // Wait for task to start
    await sleep(2000);
    const taskStatus = await api('/api/task/' + taskId);
    check('task GET returns 200', taskStatus.status === 200);
    check('task has status field', taskStatus.json.task && typeof taskStatus.json.task.status === 'string');

    // === Active tasks ===
    const active = await api('/api/tasks');
    check('active tasks returns 200', active.status === 200);
    check('active tasks has tasks array', Array.isArray(active.json.tasks));

    // === Knowledge search ===
    const knowledge = await api('/api/knowledge/search?q=test');
    check('knowledge search returns 200', knowledge.status === 200);
    check('knowledge search has results', Array.isArray(knowledge.json.results));

    // === Macros ===
    const macros = await api('/api/macros');
    check('macros returns 200', macros.status === 200);

    // === Sessions ===
    const sessions = await api('/api/sessions');
    check('sessions returns 200', sessions.status === 200);

    // === Privacy stats ===
    const privacy = await api('/api/privacy/stats');
    check('privacy stats returns 200', privacy.status === 200);

    // === Swarm status ===
    const swarm = await api('/api/swarm');
    check('swarm status returns 200', swarm.status === 200);

    // === Audit stats ===
    const audit = await api('/api/vault/stats');
    check('audit stats returns 200', audit.status === 200);

    // === MCP catalog ===
    const catalog = await api('/api/mcp/catalog?limit=10');
    check('mcp catalog returns 200', catalog.status === 200);
    check('mcp catalog has catalog array', Array.isArray(catalog.json.catalog));
    check('mcp catalog has entries', catalog.json.catalog && catalog.json.catalog.length > 0);

    // === MCP connectors (enabled) ===
    const connectors = await api('/api/mcp/connectors');
    check('mcp connectors returns 200', connectors.status === 200);
    check('mcp connectors has connectors array', Array.isArray(connectors.json.connectors));

    // === Chrome extension status ===
    const chromeStatus = await api('/api/chrome/status');
    check('chrome status returns 200', chromeStatus.status === 200);
    check('chrome status has eventCount', typeof chromeStatus.json.eventCount === 'number');

    // === Chrome logins ===
    const logins = await api('/api/chrome/logins');
    check('chrome logins returns 200', logins.status === 200);
    check('chrome logins returns array', Array.isArray(logins.json));

    // === Connected connectors ===
    const connected = await api('/api/connectors');
    check('connected connectors returns 200', connected.status === 200);
    check('connected connectors has connectors array', Array.isArray(connected.json.connectors));

    // === Voice status ===
    const voice = await api('/api/voice/status');
    check('voice status returns 200', voice.status === 200);
    check('voice status has providers', typeof voice.json === 'object');

    // === Meeting status ===
    const meeting = await api('/api/meeting/status');
    check('meeting status returns 200', meeting.status === 200);

    // === Screen status ===
    const screen = await api('/api/screen/live');
    // Screen may not be available in headless mode
    if (screen.status === 200) {
      check('screen live returns 200', true);
    } else {
      console.log('NOTE: screen live not available (headless mode or no screen reader)');
    }

    // === Model status ===
    const models = await api('/api/llm/models');
    check('llm models returns 200', models.status === 200);

    // === Plan usage ===
    const plan = await api('/api/plan/usage');
    check('plan usage returns 200', plan.status === 200);

    // === Memory recall ===
    const memory = await api('/api/memory/recall?q=test');
    check('memory recall returns 200', memory.status === 200);

    // === Docker list ===
    const docker = await api('/api/docker/list');
    check('docker list returns 200', docker.status === 200);

    // === Mesh status ===
    const mesh = await api('/api/mesh/status');
    check('mesh status returns 200', mesh.status === 200);

    // === Telco status ===
    const telco = await api('/api/telco/status');
    check('telco status returns 200', telco.status === 200);

    // === Device list ===
    const devices = await api('/api/devices');
    check('devices list returns 200', devices.status === 200);

  } catch (err) {
    console.error('Test error:', err);
    failures++;
  } finally {
    child.kill('SIGTERM');
    await sleep(1000);
    console.log(`\n=== RESULTS: ${passes} passed, ${failures} failed ===`);
    process.exit(failures > 0 ? 1 : 0);
  }
}

main();
