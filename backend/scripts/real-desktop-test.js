const path = require('path');
const { spawn } = require('child_process');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const API = 'http://127.0.0.1:8787';

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('PASS: ' + label);
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

async function runTask(description, timeoutMs) {
  const task = await api('/api/task', 'POST', { description, priority: 1 });
  check('task submitted: ' + description, task.status === 200 && !!task.json.taskId);
  const taskId = task.json.taskId;
  let finalTask = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await api('/api/task/' + taskId);
    if (t.json.task && ['completed', 'failed', 'cancelled'].includes(t.json.task.status)) {
      finalTask = t.json.task;
      break;
    }
    await sleep(2000);
  }
  return finalTask;
}

async function main() {
  const child = spawn('node', ['dist/index.js'], {
    cwd: umbra,
    env: { ...process.env, UMBRA_ENGINE: 'desktop2' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let exitCode = null;
  const exitPromise = new Promise(resolve => {
    child.on('exit', code => { exitCode = code; resolve(code); });
  });
  child.stdout.on('data', d => process.stdout.write(d));

  try {
    check('os booted', await waitForApi(120000), 'API not reachable in 120s');

    const consentReqP = api('/api/consent', 'POST', { action: 'request', reason: 'Real-desktop test grant' });
    child.stdin.write('y\n');
    await consentReqP;
    await sleep(3000);
    const c = await api('/api/consent');
    check('consent granted', c.json.granted === true);

    console.log('\n=== TASK 1: Notepad on Desktop 2 ===');
    const t1 = await runTask('Open Notepad on Desktop 2, type the text "Hello Umbra" in it, then read the screen and tell me what text appears', 420000);
    check('task1 terminal', !!t1, 'timeout');
    if (t1) {
      check('task1 completed', t1.status === 'completed', 'status=' + t1.status + ' err=' + (t1.error || ''));
      const steps = JSON.stringify((t1.result || {}).steps || []);
      check('task1 used open_app', steps.includes('open_app'), steps.substring(0, 300));
      check('task1 used app_type', steps.includes('app_type'), steps.substring(0, 300));
      check('task1 used read_screen', steps.includes('read_screen'), steps.substring(0, 300));
      check('task1 verified content', /Hello Umbra|Hello/i.test(steps), steps.substring(0, 300));
    }
    const s1 = await api('/api/status');
    check('realDesktop open after task1', s1.json.realDesktop && s1.json.realDesktop.isOpen === true);

    console.log('\n=== TASK 2: Real Chrome on Desktop 2 ===');
    const t2 = await runTask('Open Chrome on Desktop 2, go to example.com, then read the page title', 420000);
    check('task2 terminal', !!t2, 'timeout');
    if (t2) {
      check('task2 completed', t2.status === 'completed', 'status=' + t2.status + ' err=' + (t2.error || ''));
      const steps = JSON.stringify((t2.result || {}).steps || []);
      check('task2 used open_chrome', steps.includes('open_chrome'), steps.substring(0, 300));
      check('task2 verified title', /Example Domain|example\.com/i.test(steps), steps.substring(0, 300));
    }
    const s2 = await api('/api/status');
    check('realDesktop chromeMode', s2.json.realDesktop && s2.json.realDesktop.chromeMode === true,
      JSON.stringify(s2.json.realDesktop).substring(0, 200));

    const shut = await api('/api/shutdown', 'POST');
    check('shutdown responds', shut.status === 200);
    check('shutdown clean exit', await Promise.race([
      exitPromise.then(() => true),
      new Promise(r => setTimeout(() => r(false), 20000)),
    ]) && exitCode === 0, 'exit=' + exitCode);
  } finally {
    if (exitCode === null && !child.killed) {
      child.kill();
      await Promise.race([exitPromise, new Promise(r => setTimeout(r, 10000))]);
    }
  }

  console.log(failures === 0 ? 'FINAL REAL-DESKTOP TEST PASSED' : 'FINAL REAL-DESKTOP TEST FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.log('FATAL: ' + e.message); process.exit(2); });
