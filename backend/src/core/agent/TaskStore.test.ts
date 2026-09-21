import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskStore } from './TaskStore';
import { Task } from '../../types';

const tmpDirs: string[] = [];

function makeDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: 'persist me',
    status: 'executing',
    priority: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('TaskStore', () => {
  it('round-trips a task, reviving dates and nested step fields', () => {
    const store = new TaskStore(makeDir('taskstore'));
    const task = makeTask({
      startedAt: new Date('2026-01-02T03:04:05.000Z'),
      plan: [{ description: 'wait', action: 'wait', params: { ms: 1 }, requiresKnowledge: [] }],
      steps: [{
        description: 'did a thing',
        action: 'wait',
        params: {},
        result: 'ok',
        startedAt: new Date('2026-01-02T03:04:06.000Z'),
        completedAt: new Date('2026-01-02T03:04:07.000Z'),
      }],
      completedStepCount: 1,
      consentGranted: true,
      resumeNode: 'desktop',
    });

    store.save(task);
    const loaded = store.loadAll();

    expect(loaded).toHaveLength(1);
    const t = loaded[0];
    expect(t.id).toBe(task.id);
    expect(t.description).toBe('persist me');
    expect(t.createdAt).toBeInstanceOf(Date);
    expect(t.startedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(t.plan).toHaveLength(1);
    expect(t.steps![0].result).toBe('ok');
    expect(t.steps![0].completedAt).toBeInstanceOf(Date);
    expect(t.completedStepCount).toBe(1);
    expect(t.consentGranted).toBe(true);
    expect(t.resumeNode).toBe('desktop');
  });

  it('only returns unfinished tasks from loadUnfinished', () => {
    const store = new TaskStore(makeDir('taskstore-unfinished'));
    const running = makeTask({ id: 'a', status: 'executing' });
    const done = makeTask({ id: 'b', status: 'completed' });
    const failed = makeTask({ id: 'c', status: 'failed' });
    const pending = makeTask({ id: 'd', status: 'planning' });

    for (const t of [running, done, failed, pending]) store.save(t);

    const unfinished = store.loadUnfinished().map(t => t.id).sort();
    expect(unfinished).toEqual(['a', 'd']);
  });

  it('remove deletes a task file', () => {
    const store = new TaskStore(makeDir('taskstore-remove'));
    const task = makeTask();
    store.save(task);
    expect(store.loadAll()).toHaveLength(1);
    store.remove(task.id);
    expect(store.loadAll()).toHaveLength(0);
  });

  it('skips corrupt files without throwing', () => {
    const dir = makeDir('taskstore-corrupt');
    const store = new TaskStore(dir);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json', 'utf-8');
    const good = makeTask();
    store.save(good);
    expect(store.loadAll().map(t => t.id)).toEqual([good.id]);
  });
});
