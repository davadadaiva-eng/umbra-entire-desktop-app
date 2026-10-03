import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStep, ActivityEntry, InputRequest } from '../../types';
import { getLogger } from '../Logger';
import { createHash } from 'crypto';

/**
 * TaskStore — durable task queue so in-flight work survives a restart.
 *
 * Every submitted task is written to `<dir>/<id>.json` and re-written after
 * each completed step (checkpoint). On boot the node reloads unfinished tasks
 * and resumes them from `completedStepCount`. This is the foundation for the
 * "continue on the cloud" flow: desktop and cloud nodes mount the same dir
 * (see UMBRA_TASK_DIR) and whichever node is alive picks up the queue.
 */
export class TaskStore {
  private dir: string;
  private activityDir: string;
  private inputDir: string;

  constructor(dir?: string) {
    this.dir = dir || process.env.UMBRA_TASK_DIR || '';
    if (!this.dir) {
      const base = process.env.USERPROFILE || '~';
      this.dir = path.join(base, '.umbra', 'task-queue');
    }
    this.activityDir = path.join(this.dir, 'activity');
    this.inputDir = path.join(this.dir, 'inputs');
  }

  get storeDir(): string {
    return this.dir;
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private activityFileFor(taskId: string): string {
    return path.join(this.activityDir, `${taskId}.json`);
  }

  private inputFileFor(taskId: string): string {
    return path.join(this.inputDir, `${taskId}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    if (!fs.existsSync(this.activityDir)) {
      fs.mkdirSync(this.activityDir, { recursive: true });
    }
    if (!fs.existsSync(this.inputDir)) {
      fs.mkdirSync(this.inputDir, { recursive: true });
    }
  }

  /** Persist (or checkpoint) a task. Writes atomically via temp + rename. */
  save(task: Task): void {
    try {
      this.ensureDir();
      const tmp = this.fileFor(task.id) + '.tmp';
      const taskToSave = {
        ...task,
        version: (task.version ?? 0) + 1,
      };
      fs.writeFileSync(tmp, JSON.stringify(this.serialize(taskToSave), null, 2), 'utf-8');
      fs.renameSync(tmp, this.fileFor(task.id));
    } catch (err: any) {
      // Persistence is best-effort — never fail a task over a write error.
      getLogger().warn({ taskId: task.id, err: err.message }, 'TaskStore: save failed');
    }
  }

  /** Remove a finished task from the queue (it lives on in recall/memory). */
  remove(id: string): void {
    try {
      const file = this.fileFor(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err: any) {
      getLogger().debug({ taskId: id, err: err.message }, 'TaskStore: remove failed');
    }
  }

  /** Load every persisted task, newest first. Dates are revived to Date objects. */
  loadAll(): Task[] {
    try {
      this.ensureDir();
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
      const tasks: Task[] = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8');
          tasks.push(this.deserialize(JSON.parse(raw)));
        } catch (err: any) {
          getLogger().warn({ file, err: err.message }, 'TaskStore: corrupt task file skipped');
        }
      }
      return tasks.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    } catch {
      return [];
    }
  }

  /** Unfinished tasks only (pending/planning/executing/healing). */
  loadUnfinished(): Task[] {
    const unfinished = new Set(['pending', 'planning', 'executing', 'healing', 'waiting_input', 'paused']);
    return this.loadAll().filter(t => unfinished.has(t.status));
  }

  /** Find a task by its idempotency key (for deduplication). */
  getTaskByIdempotencyKey(key: string): Task | undefined {
    const all = this.loadAll();
    return all.find(t => t.idempotencyKey === key);
  }

  /**
   * Compare-and-swap: atomically update a task if its version matches.
   * Returns the updated task on success, or undefined if the version mismatch.
   */
  compareAndSwap(taskId: string, expectedVersion: number, updates: Partial<Task>): Task | undefined {
    try {
      const file = this.fileFor(taskId);
      if (!fs.existsSync(file)) return undefined;

      const raw = fs.readFileSync(file, 'utf-8');
      const current = this.deserialize(JSON.parse(raw));

      if (current.version !== expectedVersion) {
        return undefined; // version mismatch — concurrent modification
      }

      const updated: Task = {
        ...current,
        ...updates,
        version: expectedVersion + 1,
        id: current.id, // preserve id
        createdAt: current.createdAt, // preserve createdAt
      };

      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.serialize(updated), null, 2), 'utf-8');
      fs.renameSync(tmp, file);

      return updated;
    } catch (err: any) {
      getLogger().warn({ taskId, err: err.message }, 'TaskStore: compareAndSwap failed');
      return undefined;
    }
  }

  /** Generate SHA-256 idempotency key from task input. */
  static generateIdempotencyKey(input: string, intent?: string): string {
    const payload = JSON.stringify({ input, intent });
    return createHash('sha256').update(payload).digest('hex');
  }

  /** Log an activity entry for a task. */
  logActivity(taskId: string, title: string, detail: string, status: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    try {
      this.ensureDir();
      const file = this.activityFileFor(taskId);
      let entries: ActivityEntry[] = [];
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        entries = JSON.parse(raw);
      }
      const entry: ActivityEntry = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        taskId,
        title,
        detail,
        status,
        timestamp: new Date(),
      };
      entries.push(entry);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err: any) {
      getLogger().warn({ taskId, err: err.message }, 'TaskStore: logActivity failed');
    }
  }

  /** Get all activity entries for a task, ordered by timestamp. */
  getActivity(taskId: string): ActivityEntry[] {
    try {
      const file = this.activityFileFor(taskId);
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, 'utf-8');
      const entries = JSON.parse(raw);
      return entries.map((e: any) => ({
        ...e,
        timestamp: new Date(e.timestamp),
      })).sort((a: ActivityEntry, b: ActivityEntry) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch (err: any) {
      getLogger().warn({ taskId, err: err.message }, 'TaskStore: getActivity failed');
      return [];
    }
  }

  /** Create an input request for a task (pauses execution). */
  createInputRequest(taskId: string, question: string, options?: string[]): InputRequest {
    try {
      this.ensureDir();
      const file = this.inputFileFor(taskId);
      let requests: InputRequest[] = [];
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        requests = JSON.parse(raw);
      }
      const request: InputRequest = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        taskId,
        question,
        options,
        createdAt: new Date(),
      };
      requests.push(request);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(requests, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
      return request;
    } catch (err: any) {
      getLogger().warn({ taskId, err: err.message }, 'TaskStore: createInputRequest failed');
      throw err;
    }
  }

  /** Get all input requests for a task. */
  getInputRequests(taskId: string): InputRequest[] {
    try {
      const file = this.inputFileFor(taskId);
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, 'utf-8');
      const requests = JSON.parse(raw);
      return requests.map((r: any) => ({
        ...r,
        createdAt: new Date(r.createdAt),
        answeredAt: r.answeredAt ? new Date(r.answeredAt) : undefined,
      })).sort((a: InputRequest, b: InputRequest) => a.createdAt.getTime() - b.createdAt.getTime());
    } catch (err: any) {
      getLogger().warn({ taskId, err: err.message }, 'TaskStore: getInputRequests failed');
      return [];
    }
  }

  /** Get the latest unanswered input request for a task. */
  getPendingInputRequest(taskId: string): InputRequest | undefined {
    const requests = this.getInputRequests(taskId);
    return requests.find(r => !r.answeredAt);
  }

  /** Answer an input request and mark it as completed. */
  answerInputRequest(taskId: string, inputId: string, answer: string): InputRequest | undefined {
    try {
      const file = this.inputFileFor(taskId);
      if (!fs.existsSync(file)) return undefined;
      const raw = fs.readFileSync(file, 'utf-8');
      const requests: InputRequest[] = JSON.parse(raw);
      const index = requests.findIndex(r => r.id === inputId);
      if (index === -1) return undefined;
      requests[index].answeredAt = new Date();
      requests[index].answer = answer;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(requests, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
      return requests[index];
    } catch (err: any) {
      getLogger().warn({ taskId, inputId, err: err.message }, 'TaskStore: answerInputRequest failed');
      return undefined;
    }
  }

  private serialize(task: Task): Record<string, unknown> {
    return {
      ...task,
      createdAt: task.createdAt?.toISOString(),
      startedAt: task.startedAt ? task.startedAt.toISOString() : undefined,
      completedAt: task.completedAt ? task.completedAt.toISOString() : undefined,
      version: task.version ?? 0,
      idempotencyKey: task.idempotencyKey,
      steps: task.steps?.map(s => ({
        ...s,
        startedAt: s.startedAt?.toISOString(),
        completedAt: s.completedAt?.toISOString(),
      })),
    };
  }

  private deserialize(raw: Record<string, unknown>): Task {
    const revive = (v: unknown): Date | undefined => (typeof v === 'string' ? new Date(v) : undefined);
    const steps: TaskStep[] | undefined = Array.isArray(raw.steps)
      ? (raw.steps as any[]).map(s => ({
          description: String(s.description ?? ''),
          action: String(s.action ?? ''),
          params: (s.params && typeof s.params === 'object') ? s.params as Record<string, unknown> : {},
          result: s.result !== undefined ? String(s.result) : undefined,
          error: s.error !== undefined ? String(s.error) : undefined,
          startedAt: revive(s.startedAt) ?? new Date(),
          completedAt: revive(s.completedAt) ?? new Date(),
        }))
      : undefined;

    return {
      id: String(raw.id ?? ''),
      description: String(raw.description ?? ''),
      status: (raw.status as Task['status']) ?? 'pending',
      priority: Number(raw.priority ?? 0),
      createdAt: revive(raw.createdAt) ?? new Date(),
      startedAt: revive(raw.startedAt),
      completedAt: revive(raw.completedAt),
      assignedSwarmId: raw.assignedSwarmId !== undefined ? Number(raw.assignedSwarmId) : undefined,
      result: raw.result as Task['result'],
      error: raw.error !== undefined ? String(raw.error) : undefined,
      plan: Array.isArray(raw.plan) ? raw.plan as Task['plan'] : undefined,
      steps,
      completedStepCount: raw.completedStepCount !== undefined ? Number(raw.completedStepCount) : undefined,
      consentGranted: raw.consentGranted === true,
      resumeNode: (raw.resumeNode as Task['resumeNode']) || undefined,
      version: raw.version !== undefined ? Number(raw.version) : 0,
      idempotencyKey: raw.idempotencyKey as string | undefined,
      leaseOwner: raw.leaseOwner !== undefined ? String(raw.leaseOwner) : undefined,
      leaseDeadline: raw.leaseDeadline !== undefined ? String(raw.leaseDeadline) : undefined,
    };
  }
}
