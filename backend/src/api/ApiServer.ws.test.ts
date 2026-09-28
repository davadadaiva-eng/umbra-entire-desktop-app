/**
 * `GET /api/ws` — the live event stream the Electron renderer binds to.
 *
 * Covered here:
 *  - the on-connect `snapshot` frame (and that it carries the full status,
 *    including `bridges` + `credVault`);
 *  - task lifecycle fan-out (created → started → completed/failed/cancelled),
 *    which is the event set the HUD depends on;
 *  - the other subscribed bus events;
 *  - multi-client broadcast + dead-socket pruning;
 *  - unsubscribing on stop() so a restarted server does not double-deliver.
 */
import WebSocket from 'ws';
import { ApiServer } from './ApiServer';
import { eventBus } from '../core/EventBus';
import { makeFullDeps, makeStatus, type FullDeps } from './testkit';

const PORT = 43000 + Math.floor(Math.random() * 4000);

let deps: FullDeps;
let server: ApiServer;

/** Connect, drain `snapshot`, and hand back a collector for later frames. */
function connect(): Promise<{
  ws: WebSocket;
  snapshot: any;
  /** Frames received after the snapshot, in order. */
  frames: any[];
  /** Resolve once a frame matching `pred` arrives (or reject on timeout). */
  waitFor(pred: (f: any) => boolean, ms?: number): Promise<any>;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`);
    const frames: any[] = [];
    let snapshot: any;
    const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out waiting for the snapshot frame'));
    }, 5000);

    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'snapshot' && snapshot === undefined) {
        snapshot = frame.status;
        clearTimeout(timer);
        resolve({
          ws,
          snapshot,
          frames,
          waitFor: (pred, ms = 3000) => new Promise((res, rej) => {
            const existing = frames.find(pred);
            if (existing) { res(existing); return; }
            const t = setTimeout(() => {
              rej(new Error(`timed out waiting for a matching frame; got ${JSON.stringify(frames.map(f => f.name))}`));
            }, ms);
            waiters.push({ pred, resolve: f => { clearTimeout(t); res(f); } });
          }),
          close: () => ws.close(),
        });
        return;
      }
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

beforeAll(() => {
  deps = makeFullDeps();
  server = new ApiServer(deps as any, PORT);
  server.start();
});

afterAll(async () => {
  await server.stop();
});

// ── Handshake ──────────────────────────────────────────────────────

describe('ws handshake', () => {
  test('sends a snapshot frame on connect', async () => {
    const c = await connect();
    try {
      expect(c.snapshot).toBeDefined();
      expect(c.snapshot.initialized).toBe(true);
    } finally {
      c.close();
    }
  });

  test('the snapshot carries bridges + credVault, not a trimmed status', async () => {
    const c = await connect();
    try {
      expect(c.snapshot.bridges).toBeDefined();
      expect(c.snapshot.bridges.fastEngine).toBeDefined();
      expect(c.snapshot.credVault).toEqual({ locked: false, available: true, message: 'Vault unlocked' });
    } finally {
      c.close();
    }
  });

  test('rejects a WebSocket on a different path', async () => {
    // The server is mounted at /api/ws only; anything else is a normal HTTP 404.
    const res = await fetch(`http://127.0.0.1:${PORT}/not-ws`);
    expect(res.status).toBe(404);
  });
});

// ── Task lifecycle fan-out ─────────────────────────────────────────

describe('ws task lifecycle events', () => {
  const lifecycle: Array<[string, unknown[]]> = [
    ['task:created', ['t-100']],
    ['task:started', ['t-100']],
    ['task:completed', ['t-100', { summary: 'done' }]],
  ];

  test('broadcasts task:created, task:started and task:completed in order', async () => {
    const c = await connect();
    try {
      for (const [name, payload] of lifecycle) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (eventBus.emit as any)(name, ...payload);
        await c.waitFor(f => f.name === name);
      }
      expect(c.frames.map(f => f.name)).toEqual(['task:created', 'task:started', 'task:completed']);
    } finally {
      c.close();
    }
  });

  test('wraps a single bus argument as the payload (not an array)', async () => {
    const c = await connect();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)('task:failed', 't-200', 'boom');
      const frame = await c.waitFor(f => f.name === 'task:failed');
      // Two args ⇒ the array form.
      expect(frame.payload).toEqual(['t-200', 'boom']);
    } finally {
      c.close();
    }
  });

  test('unwraps a single bus argument as a bare value', async () => {
    const c = await connect();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)('task:cancelled', 't-300');
      const frame = await c.waitFor(f => f.name === 'task:cancelled');
      expect(frame.payload).toBe('t-300');
    } finally {
      c.close();
    }
  });

  test('every frame carries the envelope the client switches on', async () => {
    const c = await connect();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)('task:created', 't-400');
      const frame = await c.waitFor(f => f.name === 'task:created');
      expect(frame.type).toBe('event');
      expect(typeof frame.name).toBe('string');
      expect(frame).toHaveProperty('payload');
    } finally {
      c.close();
    }
  });

  test('every task lifecycle event in the bus is subscribed', async () => {
    const c = await connect();
    try {
      const names = ['task:created', 'task:started', 'task:completed', 'task:failed', 'task:cancelled'];
      for (const name of names) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (eventBus.emit as any)(name, 't-500');
        const frame = await c.waitFor(f => f.name === name);
        expect(frame.name).toBe(name);
      }
    } finally {
      c.close();
    }
  });
});

// ── Other subscribed events ────────────────────────────────────────

describe('ws non-task events', () => {
  test.each([
    ['app:ready', ['ready']],
    ['swarm:allocated', [{ slot: 1 }]],
    ['display:created', [{ id: 'd1' }]],
    ['healing:recovered', ['t-9']],
    ['config:changed', [{ key: 'provider' }]],
    ['knowledge:updated', [{ id: 'n1' }]],
    ['vault:entry', ['github']],
    ['meeting:order', [{ kind: 'summarize' }]],
    ['chrome:telemetry', [{ count: 1 }]],
  ])('forwards %s', async (name, payload) => {
    const c = await connect();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)(name, ...payload);
      const frame = await c.waitFor(f => f.name === name);
      expect(frame.name).toBe(name);
    } finally {
      c.close();
    }
  });

  test('coalesces high-frequency screen events instead of flooding', async () => {
    const c = await connect();
    try {
      // Three cursor moves back to back. The first is outside the 1s window and
      // goes out immediately; the rest collapse into a single trailing flush, so
      // a burst of N becomes 2 frames (immediate + coalesced tail), not N.
      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (eventBus.emit as any)('screen:cursor', { x: i, y: i });
      }
      await c.waitFor(f => f.name === 'screen:cursor', 4000);
      // Give the coalescing window time to decide whether more will arrive.
      await new Promise(r => setTimeout(r, 1200));
      const cursorFrames = c.frames.filter(f => f.name === 'screen:cursor');
      expect(cursorFrames.length).toBeLessThanOrEqual(2);
      // The coalesced frame carries the NEWEST state, not the first queued one.
      const last = cursorFrames[cursorFrames.length - 1];
      expect(last.payload).toEqual({ x: 2, y: 2 });
    } finally {
      c.close();
    }
  });
});

// ── Fan-out behaviour ──────────────────────────────────────────────

describe('ws fan-out', () => {
  const clients = () => (server as any).clients as Set<WebSocket>;

  /** Poll until `fn()` is true — socket close/error events are asynchronous. */
  async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fn()) return;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('condition not reached in time');
  }

  test('delivers each event to every connected client', async () => {
    const a = await connect();
    const b = await connect();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)('task:created', 't-broadcast');
      const [fa, fb] = await Promise.all([
        a.waitFor(f => f.name === 'task:created'),
        b.waitFor(f => f.name === 'task:created'),
      ]);
      expect(fa.payload).toBe('t-broadcast');
      expect(fb.payload).toBe('t-broadcast');
    } finally {
      a.close();
      b.close();
    }
  });

  test('prunes a client that disconnected without a close frame', async () => {
    // Baseline: let any socket from an earlier test finish its close handshake.
    await waitUntil(() => clients().size === 0);
    const a = await connect();
    const b = await connect();
    try {
      expect(clients().size).toBe(2);
      // Terminate b's socket the rude way — no close handshake.
      (b.ws as any).terminate();
      await waitUntil(() => clients().size === 1);
      // The server dropped b rather than throwing on a send to a dead socket.
      expect(clients().size).toBe(1);
      // ...and the surviving client still receives events.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)('task:created', 't-after-terminate');
      const frame = await a.waitFor(f => f.name === 'task:created');
      expect(frame.payload).toBe('t-after-terminate');
    } finally {
      a.close();
    }
  });

  test('stops delivering after the client closes', async () => {
    const c = await connect();
    c.close();
    await waitUntil(() => clients().size === 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (eventBus.emit as any)('task:created', 't-after-close');
    await new Promise(r => setTimeout(r, 200));
    expect(c.frames.some(f => f.name === 'task:created')).toBe(false);
  });

  test('unsubscribes from the bus on stop() — no double-delivery after restart', async () => {
    const local = new ApiServer(makeFullDeps() as any, PORT + 1);
    local.start();
    const c = await new Promise<{ ws: WebSocket; frames: any[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}/api/ws`);
      const frames: any[] = [];
      ws.on('message', raw => {
        const f = JSON.parse(raw.toString());
        if (f.type === 'snapshot') resolve({ ws, frames });
        else frames.push(f);
      });
      ws.on('error', reject);
    });

    try {
      await local.stop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)('task:created', 't-after-stop');
      await new Promise(r => setTimeout(r, 300));
      expect(c.frames.length).toBe(0);
    } finally {
      c.ws.close();
    }
  });
});

// ── Status freshness ───────────────────────────────────────────────

describe('ws status reflects getStatus()', () => {
  test('a changing status is reflected in the next snapshot', async () => {
    const local = new ApiServer(
      makeFullDeps({ getStatus: async () => makeStatus({ initialized: false, uptimeMs: 42 }) }) as any,
      PORT + 2,
    );
    local.start();
    try {
      const c = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT + 2}/api/ws`);
        ws.on('message', raw => {
          const f = JSON.parse(raw.toString());
          if (f.type === 'snapshot') resolve({ ws, snapshot: f.status });
        });
        ws.on('error', reject);
      });
      expect(c.snapshot.initialized).toBe(false);
      expect(c.snapshot.uptimeMs).toBe(42);
      c.ws.close();
    } finally {
      await local.stop();
    }
  });

  test('a getStatus() rejection does not break the connection', async () => {
    const local = new ApiServer(
      makeFullDeps({ getStatus: async () => { throw new Error('status unavailable'); } }) as any,
      PORT + 3,
    );
    local.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT + 3}/api/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      // Still open and still receiving events despite the failed snapshot.
      const frame = new Promise<any>((resolve) => {
        ws.on('message', raw => {
          const f = JSON.parse(raw.toString());
          if (f.type === 'event') resolve(f);
        });
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus.emit as any)('task:created', 't-despite-status-failure');
      const f = await frame;
      expect(f.name).toBe('task:created');
      ws.close();
    } finally {
      await local.stop();
    }
  });
});
