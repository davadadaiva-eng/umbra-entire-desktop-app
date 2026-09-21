const { spawn } = require('child_process');
const path = require('path');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const API = 'http://127.0.0.1:8787';
const TASK = process.argv[2] || 'Who is the president of the United States?';

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
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let stdout = '';
  let consented = false;
  child.stdout.on('data', d => {
    const text = d.toString();
    stdout += text;
    process.stdout.write('[umbra] ' + text);
    if (!consented && /permission|allow|Type y|y to allow/i.test(text)) {
      consented = true;
      setTimeout(() => child.stdin.write('y\n'), 500);
    }
  });

  try {
    if (!(await waitForApi(120000))) throw new Error('API not reachable in 120s');
    console.log('\n== OS booted. Submitting task: ' + TASK);

    const task = await api('/api/task', 'POST', { description: TASK, priority: 1 });
    if (task.status !== 200) throw new Error('submit failed: ' + JSON.stringify(task.json));
    const taskId = task.json.taskId;
    console.log('task id:', taskId);

    const deadline = Date.now() + 420000;
    let finalTask = null;
    while (Date.now() < deadline) {
      const t = await api('/api/task/' + taskId);
      const st = t.json.task ? t.json.task.status : '?';
      if (t.json.task && ['completed', 'failed', 'cancelled'].includes(st)) {
        finalTask = t.json.task;
        break;
      }
      if (st !== '?') process.stdout.write('\rstatus: ' + st.padEnd(12));
      await sleep(2000);
    }
    console.log();

    if (!finalTask) throw new Error('task timeout (7 min)');

    if (finalTask.status === 'completed' && finalTask.result) {
      console.log('\n=== TASK COMPLETED ===');
      console.log('summary:', finalTask.result.summary);
      const output = finalTask.result.output || finalTask.result.summary;
      console.log('--- answer ---');
      console.log(output);
      if (finalTask.result.steps && finalTask.result.steps.length) {
        console.log('--- steps (' + finalTask.result.steps.length + ') ---');
        for (const s of finalTask.result.steps) {
          console.log('* ' + (s.description || '') + (s.result ? '\n    => ' + String(s.result).slice(0, 300) : ''));
        }
      }
    } else {
      console.log('\n=== TASK ' + finalTask.status.toUpperCase() + ' ===');
      console.log('error:', finalTask.error || '?');
      console.log('steps:', JSON.stringify(finalTask.result || '', null, 2).slice(0, 1000));
    }

    await api('/api/shutdown', 'POST');
    await Promise.race([
      new Promise(r => child.on('exit', r)),
      sleep(15000),
    ]);
  } finally {
    if (!child.killed) child.kill();
  }
}

main().catch(e => { console.error('\nFATAL: ' + e.message); process.exit(1); });
