/**
 * Worker lease ownership — claiming never steals a live lease held by
 * another worker; expired leases stay claimable so crashed workers
 * don't wedge the queue.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from './AgentRuntime';
import { TaskPlanner } from './TaskPlanner';
import { TaskStore } from './TaskStore';
import { Task } from '../../types';

const tmpDirs: string[] = [];

function makeTempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(store: TaskStore): AgentRuntime {
  const llm = {
    complete: jest.fn(async () => ({ content: 'ok', modelUsed: 'fake', totalTokens: 1, finishReason: 'stop' })),
    createEmbedding: async () => [],
    updateConfig: () => {},
  };
  const knowledge = { search: jest.fn(async () => []), learnFromExecution: jest.fn(async () => {}) };
  const planner = new TaskPlanner(knowledge as any, llm as any);
  const runtime = new AgentRuntime(llm as any, knowledge as any, planner);
  runtime.registerSubsystems({ taskStore: store });
  return runtime;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: 'leased work',
    status: 'pending',
    priority: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('workerClaim lease ownership', () => {
  it('denies a claim while another worker holds a live lease', async () => {
    const store = new TaskStore(makeTempDir('claim-live'));
    const runtime = makeRuntime(store);
    const task = makeTask();
    store.save(task);

    const first = await runtime.workerClaim(task.id, 'w-1');
    expect(first?.leaseOwner).toBe('w-1');

    const second = await runtime.workerClaim(task.id, 'w-2');
    expect(second).toBeUndefined();
  });

  it('allows a claim after the lease expires', async () => {
    const store = new TaskStore(makeTempDir('claim-expired'));
    const runtime = makeRuntime(store);
    const task = makeTask({
      status: 'executing',
      leaseOwner: 'w-dead',
      leaseDeadline: new Date(Date.now() - 1000).toISOString(),
    });
    store.save(task);

    const claimed = await runtime.workerClaim(task.id, 'w-2');
    expect(claimed?.leaseOwner).toBe('w-2');
  });

  it('heartbeat fails for a non-owner', async () => {
    const store = new TaskStore(makeTempDir('claim-hb'));
    const runtime = makeRuntime(store);
    const task = makeTask();
    store.save(task);
    await runtime.workerClaim(task.id, 'w-1');
    expect(await runtime.workerHeartbeat(task.id, 'w-2')).toBe(false);
    expect(await runtime.workerHeartbeat(task.id, 'w-1')).toBe(true);
  });
});
