const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const API = 'http://127.0.0.1:8787';
const STREAM = 'ws://127.0.0.1:9090';

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
  let exitCode = null;
  const exitPromise = new Promise(resolve => {
    child.on('exit', code => { exitCode = code; resolve(code); });
  });
  child.stdout.on('data', d => process.stdout.write(d));

  try {
    console.log('DIAG: waiting for API...');
    if (!(await waitForApi(120000))) throw new Error('API not up');
    console.log('DIAG: API up');

    await api('/api/consent', 'POST', { action: 'request', reason: 'diag grant' });
    child.stdin.write('y\n');
    await sleep(4000);
    const c = await api('/api/consent');
    console.log('DIAG: consent granted =', c.json.granted);

    const nav = await api('/api/desktop2/action', 'POST', { action: 'navigate', params: { url: 'https://example.com' } });
    console.log('DIAG: navigate status =', nav.status, JSON.stringify(nav.json).substring(0, 120));
    await sleep(4000);

    const ws = new WebSocket(STREAM);
    let frames = 0, screenshots = 0, errors = 0, other = 0;
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'frame') { frames++; if (frames === 1 || frames % 20 === 0) console.log('DIAG: frame#' + frames, 'bytes=' + (msg.image ? msg.image.length : 0)); }
      else if (msg.type === 'screenshot') { screenshots++; console.log('DIAG: screenshot reply bytes=' + (msg.image ? msg.image.length : 0), 'null?', msg.image === null); }
      else if (msg.type === 'error') { errors++; console.log('DIAG: server error:', JSON.stringify(msg)); }
      else { other++; if (other < 10) console.log('DIAG: msg type =', msg.type); }
    });
    ws.on('open', () => {
      console.log('DIAG: ws open, subscribing');
      ws.send(JSON.stringify({ type: 'subscribe' }));
      setTimeout(() => { ws.send(JSON.stringify({ type: 'screenshot' })); }, 1500);
      setTimeout(() => { ws.send(JSON.stringify({ type: 'screenshot' })); }, 5000);
    });
    ws.on('error', e => console.log('DIAG: ws error', e.message));
    await sleep(12000);
    ws.close();
    console.log('DIAG RESULT: frames=' + frames + ' screenshots=' + screenshots + ' errors=' + errors + ' other=' + other);
  } finally {
    if (exitCode === null) {
      try { await api('/api/shutdown', 'POST'); } catch { }
      await Promise.race([exitPromise, sleep(15000)]);
      if (exitCode === null) child.kill();
    }
  }
}

main().catch(e => { console.log('DIAG FATAL: ' + e.message); process.exit(2); });
