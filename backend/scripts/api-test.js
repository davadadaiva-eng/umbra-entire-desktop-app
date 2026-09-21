const path = require('path');
const http = require('http');
const fetch = require('node-fetch').default;
const WebSocket = require('ws');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const { ApiServer } = require(path.join(umbra, 'dist', 'api', 'ApiServer.js'));
const { eventBus } = require(path.join(umbra, 'dist', 'core', 'EventBus.js'));

const PORT = 8787;
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('PASS: ' + label);
  else { failures++; console.log('FAIL: ' + label + (extra ? ' — ' + extra : '')); }
}

async function api(path2, method = 'GET', body) {
  const res = await fetch(BASE + path2, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function main() {
  const deps = {
    getStatus: async () => ({ initialized: true, uptimeMs: 42, consent: { granted: false }, desktop2: { isRunning: true }, streamer: { active: true } }),
    submitTask: async desc => 'task-' + desc.length,
    getTask: id => id === 'nope' ? undefined : ({ id, description: 'fake', status: 'completed' }),
    getActiveTasks: () => [{ id: 'a1', status: 'executing' }],
    executeDesktop2: async (action, params) => `did ${action} with ${JSON.stringify(params)}`,
    requestConsent: async reason => 'granted',
    getConsentState: () => ({ granted: true, denied: false, askOncePerSession: true }),
    isEmergencyStopArmed: () => false,
    armEmergencyStop: () => { },
    disarmEmergencyStop: () => { },
    searchKnowledge: async q => [{ id: 'n1', title: 'Result for ' + q }],
    getMacros: async () => ['macro1'],
    getSessions: async () => ['s1'],
    getPrivacyStats: async () => ({ masked: 3 }),
    getActivitySummary: async () => ({ events: 5 }),
    getSwarmStatus: async () => ({ slots: 2 }),
    getAuditStats: async () => ({ entries: 7 }),
    generateJournalNow: async () => ({ ok: true }),
  };

  const server = new ApiServer(deps, PORT);
  server.start();
  await new Promise(r => setTimeout(r, 300));

  try {
    const health = await api('/api/health');
    check('health', health.status === 200 && health.json.ok === true);

    const status = await api('/api/status');
    check('status', status.status === 200 && status.json.desktop2.isRunning === true);

    const consent = await api('/api/consent');
    check('consent GET', consent.status === 200 && consent.json.emergencyStopArmed === false);

    const consentReq = await api('/api/consent', 'POST', { action: 'request', reason: 'test' });
    check('consent request', consentReq.json.result === 'granted');

    const arm = await api('/api/consent', 'POST', { action: 'arm' });
    check('consent arm', arm.json.result === 'armed');

    const badConsent = await api('/api/consent', 'POST', { action: 'explode' });
    check('consent bad action -> 500', badConsent.status === 500);

    const task = await api('/api/task', 'POST', { description: 'hello', priority: 2 });
    check('task submit', task.status === 200 && task.json.taskId === 'task-5');

    const taskNoDesc = await api('/api/task', 'POST', {});
    check('task no description -> 500', taskNoDesc.status === 500);

    const taskGet = await api('/api/task/task-5');
    check('task get', taskGet.status === 200 && taskGet.json.task.status === 'completed');

    const taskMissing = await api('/api/task/nope');
    check('task missing -> 500', taskMissing.status === 500);

    const tasks = await api('/api/tasks');
    check('tasks list', tasks.json.tasks.length === 1);

    const act = await api('/api/desktop2/action', 'POST', { action: 'navigate', params: { url: 'example.com' } });
    check('desktop2 action', act.status === 200 && act.json.result.includes('navigate'));

    const k = await api('/api/knowledge/search?q=test');
    check('knowledge search', k.json.results[0].title === 'Result for test');

    const macros = await api('/api/macros');
    check('macros', macros.json.macros.length === 1);

    const sessions = await api('/api/sessions');
    check('sessions', sessions.json.sessions.length === 1);

    const priv = await api('/api/privacy/stats');
    check('privacy stats', priv.json.masked === 3);

    const actSum = await api('/api/activity/summary');
    check('activity summary', actSum.json.events === 5);

    const swarm = await api('/api/swarm');
    check('swarm', swarm.json.swarm.slots === 2);

    const vault = await api('/api/vault/stats');
    check('vault', vault.json.vault.entries === 7);

    const journal = await api('/api/journal/generate', 'POST');
    check('journal', journal.json.journal.ok === true);

    const notFound = await api('/api/nope');
    check('404 route', notFound.status === 404);

    const badJson = await api('/api/task', 'POST', '{bad json');
    check('invalid json -> 500', badJson.status === 500);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/api/ws');
      let gotSnapshot = false;
      let gotEvent = false;
      const timer = setTimeout(() => {
        ws.close();
        if (!gotSnapshot || !gotEvent) { reject(new Error('ws timeout; snapshot=' + gotSnapshot + ' event=' + gotEvent)); }
        else resolve();
      }, 4000);

      ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'snapshot') gotSnapshot = true;
        if (msg.type === 'event' && msg.name === 'task:completed') gotEvent = true;
      });
      ws.on('open', () => {
        eventBus.emit('task:completed', 't1', { summary: 'done' });
      });
      ws.on('error', reject);
    });
    check('ws snapshot + events', true);
  } catch (e) {
    failures++;
    console.log('FAIL: harness error — ' + e.message);
  } finally {
    await server.stop();
  }

  console.log(failures === 0 ? 'API TEST PASSED' : 'API TEST FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.log('FATAL: ' + e.message); process.exit(2); });
