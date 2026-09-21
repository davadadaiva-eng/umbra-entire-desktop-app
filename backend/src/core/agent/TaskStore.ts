import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStep } from '../../types';
import { getLogger } from '../Logger';

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

  constructor(dir?: string) {
    this.dir = dir || process.env.UMBRA_TASK_DIR || '';
    if (!this.dir) {
      const base = process.env.USERPROFILE || '~';
      this.dir = path.join(base, '.umbra', 'task-queue');
    }
  }

  get storeDir(): string {
    return this.dir;
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Persist (or checkpoint) a task. Writes atomically via temp + rename. */
  save(task: Task): void {
    try {
      this.ensureDir();
      const tmp = this.fileFor(task.id) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.serialize(task), null, 2), 'utf-8');
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
    const unfinished = new Set(['pending', 'planning', 'executing', 'healing']);
    return this.loadAll().filter(t => unfinished.has(t.status));
  }

  private serialize(task: Task): Record<string, unknown> {
    return {
      ...task,
      createdAt: task.createdAt?.toISOString(),
      startedAt: task.startedAt ? task.startedAt.toISOString() : undefined,
      completedAt: task.completedAt ? task.completedAt.toISOString() : undefined,
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
    };
  }
}
