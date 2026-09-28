/**
 * Sync the durable task queue between the desktop PC and the always-on cloud
 * node (see docs/cloud-deploy.md — "Sharing the queue across nodes").
 *
 *   push (default): read local ~/.umbra/task-queue/*.json and POST to the
 *                   cloud's import endpoint, which writes the files and
 *                   resumes unfinished tasks.
 *   pull:           GET the cloud's queue and write it into the local dir.
 *   worker:         run a lease-based task worker that claims and executes tasks.
 *
 * Usage:
 *   UMBRA_API_URL=https://umbra.example.com npm run sync:queue -- push
 *   UMBRA_API_URL=https://umbra.example.com npm run sync:queue -- pull
 *   UMBRA_API_URL=https://umbra.example.com npm run sync:queue -- worker --worker-id=my-worker
 *
 * Optional:
 *   UMBRA_TASK_QUEUE_DIR  override the local queue dir (default ~/.umbra/task-queue)
 *   UMBRA_WORKER_ID       worker identifier (default: hostname-pid)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const API_URL = (process.env.UMBRA_API_URL || '').replace(/\/+$/, '');
const args = process.argv.slice(2);
const direction = args[0] === 'pull' ? 'pull' : args[0] === 'worker' ? 'worker' : 'push';
const workerId = (args.find(a => a.startsWith('--worker-id='))?.split('=')[1]) ||
                 process.env.UMBRA_WORKER_ID ||
                 `${os.hostname()}-${process.pid}`;
const taskQueueDir = process.env.UMBRA_TASK_QUEUE_DIR || path.join(os.homedir(), '.umbra', 'task-queue');
const HEARTBEAT_INTERVAL_MS = 30000; // 30s
const LEASE_DURATION_MS = 60000; // 60s

function readLocalFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  if (!fs.existsSync(taskQueueDir)) return files;
  for (const f of fs.readdirSync(taskQueueDir)) {
    if (f.endsWith('.json') && !f.endsWith('.tmp')) {
      files[f] = fs.readFileSync(path.join(taskQueueDir, f), 'utf-8');
    }
  }
  return files;
}

function writeLocalFiles(files: Record<string, string>): number {
  fs.mkdirSync(taskQueueDir, { recursive: true });
  let n = 0;
  for (const [name, content] of Object.entries(files)) {
    if (path.basename(name) !== name || !name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const tmp = path.join(taskQueueDir, `${name}.tmp`);
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, path.join(taskQueueDir, name));
    n++;
  }
  return n;
}

async function apiCall(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${method} ${endpoint} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

async function runWorker(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Worker ${workerId} started`);
  let currentTaskId: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const releaseCurrentTask = async () => {
    if (currentTaskId) {
      stopHeartbeat();
      try {
        await apiCall('/api/worker/release', 'POST', { taskId: currentTaskId, workerId });
        console.log(`[${new Date().toISOString()}] Released task ${currentTaskId}`);
      } catch (err: any) {
        console.error(`[${new Date().toISOString()}] Failed to release task ${currentTaskId}:`, err.message);
      }
      currentTaskId = null;
    }
  };

  const startHeartbeat = (taskId: string) => {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
      try {
        const result = await apiCall('/api/worker/heartbeat', 'POST', { taskId, workerId });
        if (!result.ok) {
          console.log(`[${new Date().toISOString()}] Lost lease on task ${taskId}`);
          stopHeartbeat();
          currentTaskId = null;
        }
      } catch (err: any) {
        console.error(`[${new Date().toISOString()}] Heartbeat failed for ${taskId}:`, err.message);
        stopHeartbeat();
        currentTaskId = null;
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  // Initial recovery
  try {
    const result = await apiCall('/api/worker/recover', 'POST', { workerId });
    console.log(`[${new Date().toISOString()}] Recovery: reclaimed ${result.reclaimed} task(s)`);
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] Recovery failed:`, err.message);
  }

  // Main loop: poll for claimable tasks
  while (true) {
    if (!currentTaskId) {
      try {
        const tasks = await apiCall('/api/tasks');
        const claimable = (tasks.tasks as any[] || [])
          .filter(t => ['pending', 'planning', 'executing', 'healing', 'waiting_input', 'paused'].includes(t.status))
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

        for (const task of claimable) {
          try {
            const result = await apiCall('/api/worker/claim', 'POST', { taskId: task.id, workerId });
            if (result.task) {
              currentTaskId = task.id;
              console.log(`[${new Date().toISOString()}] Claimed task ${currentTaskId}`);
              startHeartbeat(currentTaskId);
              break;
            }
          } catch (err: any) {
            // Task already claimed by another worker, try next
          }
        }

        if (!currentTaskId) {
          console.log(`[${new Date().toISOString()}] No claimable tasks, sleeping...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (err: any) {
        console.error(`[${new Date().toISOString()}] Failed to fetch tasks:`, err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    } else {
      // Task claimed - in a real implementation, this would execute the task
      // For now, we just maintain the heartbeat
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

async function main(): Promise<void> {
  if (!API_URL) {
    console.error('Set UMBRA_API_URL to the cloud node, e.g. https://umbra.example.com');
    process.exit(1);
  }

  if (direction === 'push') {
    const files = readLocalFiles();
    if (Object.keys(files).length === 0) {
      console.log('No local task-queue files to push.');
      return;
    }
    const res = await fetch(`${API_URL}/api/task-queue/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Import failed (${res.status}): ${JSON.stringify(json)}`);
    console.log(`Pushed ${Object.keys(files).length} file(s) → cloud resumed ${json.sync?.resumed ?? 0} task(s).`);
  } else if (direction === 'pull') {
    const res = await fetch(`${API_URL}/api/task-queue/export`);
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Export failed (${res.status}): ${JSON.stringify(json)}`);
    const n = writeLocalFiles((json.files ?? {}) as Record<string, string>);
    console.log(`Pulled ${n} file(s) into ${taskQueueDir}.`);
  } else if (direction === 'worker') {
    await runWorker();
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
