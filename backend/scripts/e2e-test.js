const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const API = 'http://127.0.0.1:8787';
const STREAM = 'ws://127.0.0.1:9090';

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

async function main() {
  const child = spawn('node', ['dist/index.js'], {
    cwd: umbra,
    env: { ...process.env, UMBRA_ENGINE: 'desktop2' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let output = '';
  let exitCode = null;
  const exitPromise = new Promise(resolve => {
    child.on('exit', code => { exitCode = code; resolve(code); });
  });
  child.stdout.on('data', d => {
    const text = d.toString();
    output += text;
    process.stdout.write(text);
  });

  try {
    check('os booted', await waitForApi(120000), 'API not reachable in 120s');

    const status = await api('/api/status');
    check('status: initialized', status.json.initialized === true);
    check('status: desktop2 running', status.json.desktop2 && status.json.desktop2.isRunning === true);
    check('status: streamer server up', status.json.streamer && status.json.streamer.port === 9090 && typeof status.json.streamer.active === 'boolean');
    check('status: consent exposed', status.json.consent && status.json.consent.emergencyStopArmed === false);
    check('status: agent desktop exposed (closed at boot)', status.json.agentDesktop && status.json.agentDesktop.open === false);

    const consentReqP = api('/api/consent', 'POST', { action: 'request', reason: 'E2E test grant' });
    child.stdin.write('y\n');
    const consentReq = await consentReqP;
    check('consent: request accepted', consentReq.status === 200);
    const granted = await new Promise(resolve => {
      const deadline = Date.now() + 35000;
      const poll = async () => {
        const c = await api('/api/consent');
        if (c.json.granted === true) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(poll, 1000);
      };
      poll();
    });
    check('consent: granted via prompt', granted);

    const task = await api('/api/task', 'POST', { description: 'Open example.com and extract the page title', priority: 1 });
    check('task: submitted', task.status === 200 && !!task.json.taskId);
    const taskId = task.json.taskId;

    let finalTask = null;
    const taskDeadline = Date.now() + 300000;
    while (Date.now() < taskDeadline) {
      const t = await api('/api/task/' + taskId);
      if (t.json.task && (t.json.task.status === 'completed' || t.json.task.status === 'failed' || t.json.task.status === 'cancelled')) {
        finalTask = t.json.task;
        break;
      }
      await sleep(1500);
    }
    check('task: reached terminal state', !!finalTask, 'timeout 300s');
    if (finalTask) {
      check('task: completed', finalTask.status === 'completed', 'status=' + finalTask.status + ' error=' + (finalTask.error || ''));
      const stepsStr = JSON.stringify(finalTask.result || '');
      check('task: ran navigate on desktop2', stepsStr.includes('Navigated to') || stepsStr.includes('navigate'), stepsStr.substring(0, 200));
      check('task: extracted title', stepsStr.includes('Example Domain'));
      check('task: step verification attached', stepsStr.includes('Verification:'));
    }

    const search = await api('/api/knowledge/search?q=example');
    check('knowledge: task learned', Array.isArray(search.json.results) && search.json.results.length > 0);

    const statusAfter = await api('/api/status');
    check('agent desktop: opened on its own during task', statusAfter.json.agentDesktop && statusAfter.json.agentDesktop.open === true);

    let frames = 0;
    let framePong = false;
    let streamActiveWhileSubscribed = false;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(STREAM);
      const timer = setTimeout(() => { ws.close(); reject(new Error('stream timeout, frames=' + frames)); }, 20000);
      ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'frame') frames++;
        if (msg.type === 'pong') framePong = true;
        if (msg.type === 'status') streamActiveWhileSubscribed = msg.status.active === true;
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe' }));
        ws.send(JSON.stringify({ type: 'ping' }));
        ws.send(JSON.stringify({ type: 'status' }));
      });
      ws.on('error', reject);
      ws.on('close', () => { clearTimeout(timer); resolve(); });
      setTimeout(() => { ws.close(); }, 10000);
    });
    check('streamer: frames received (>=3) with browser up', frames >= 3, 'frames=' + frames);
    check('streamer: pong', framePong);
    check('streamer: active while subscribed', streamActiveWhileSubscribed);

    const arm = await api('/api/consent', 'POST', { action: 'arm' });
    check('emergency stop: armed', arm.json.result === 'armed');
    const armedState = await api('/api/consent');
    check('emergency stop: reflected in state', armedState.json.emergencyStopArmed === true);
    const disarm = await api('/api/consent', 'POST', { action: 'disarm' });
    check('emergency stop: disarmed', disarm.json.result === 'disarmed');

    const block = await api('/api/desktop2/action', 'POST', { action: 'navigate', params: { url: 'https://example.com' } });
    check('desktop2: action works after grant', block.status === 200 && block.json.result.includes('Navigated'));

    const click = await api('/api/desktop2/action', 'POST', { action: 'click', params: { x: 100, y: 100 } });
    check('desktop2: consent-gated action passes after grant', click.status === 200 && click.json.result.includes('Clicked'));

    const shut = await api('/api/shutdown', 'POST');
    check('shutdown: endpoint responds', shut.status === 200);
    check('shutdown: process exited cleanly', await Promise.race([
      exitPromise.then(() => true),
      new Promise(r => setTimeout(() => r(false), 20000)),
    ]) && exitCode === 0, 'exit=' + exitCode);
  } finally {
    if (exitCode === null && !child.killed) {
      child.kill();
      await Promise.race([
        exitPromise,
        new Promise(r => setTimeout(r, 10000)),
      ]);
    }
  }

  console.log(failures === 0 ? 'FINAL E2E PASSED' : 'FINAL E2E FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.log('FATAL: ' + e.message); process.exit(2); });
