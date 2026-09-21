/**
 * Sync the durable task queue between the desktop PC and the always-on cloud
 * node (see docs/cloud-deploy.md — "Sharing the queue across nodes").
 *
 *   push (default): read local ~/.umbra/task-queue/*.json and POST to the
 *                   cloud's import endpoint, which writes the files and
 *                   resumes unfinished tasks.
 *   pull:           GET the cloud's queue and write it into the local dir.
 *
 * Usage:
 *   UMBRA_API_URL=https://umbra.example.com npm run sync:queue -- push
 *   UMBRA_API_URL=https://umbra.example.com npm run sync:queue -- pull
 *
 * Optional:
 *   UMBRA_TASK_QUEUE_DIR  override the local queue dir (default ~/.umbra/task-queue)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const API_URL = (process.env.UMBRA_API_URL || '').replace(/\/+$/, '');
const direction = process.argv[2] === 'pull' ? 'pull' : 'push';
const taskQueueDir = process.env.UMBRA_TASK_QUEUE_DIR || path.join(os.homedir(), '.umbra', 'task-queue');

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
    // Only accept safe, top-level JSON filenames (no traversal, no junk).
    if (path.basename(name) !== name || !name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const tmp = path.join(taskQueueDir, `${name}.tmp`);
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, path.join(taskQueueDir, name));
    n++;
  }
  return n;
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
  } else {
    const res = await fetch(`${API_URL}/api/task-queue/export`);
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Export failed (${res.status}): ${JSON.stringify(json)}`);
    const n = writeLocalFiles((json.files ?? {}) as Record<string, string>);
    console.log(`Pulled ${n} file(s) into ${taskQueueDir}.`);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
