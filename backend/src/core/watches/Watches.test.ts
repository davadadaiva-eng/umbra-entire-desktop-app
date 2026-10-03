/**
 * Watches tests — offline, :memory: RecordsStore. No routes wired.
 */
import { SqliteRecordsStore } from '../store/RecordsStore';
import { backoffMs, Watches, WatchError } from './Watches';

const OWNER = 'test-owner';

function setup(now = () => 1_000_000): Watches {
  return new Watches(new SqliteRecordsStore({ dbPath: ':memory:' }), OWNER, now);
}

function statusOf(p: Promise<unknown>): Promise<number | null> {
  return p.then(
    () => null,
    (err) => {
      expect(err).toBeInstanceOf(WatchError);
      return (err as WatchError).status;
    },
  );
}

describe('Watches.create', () => {
  it('validates kind-specific fields and urls', async () => {
    const watches = setup();
    expect(await statusOf(watches.create({ url: 'ftp://x', kind: 'changed', intervalSeconds: 60 }))).toBe(400);
    expect(await statusOf(watches.create({ url: 'https://x', kind: 'contains', intervalSeconds: 60 }))).toBe(400);
    expect(await statusOf(watches.create({ url: 'https://x', kind: 'priceBelow', intervalSeconds: 60 }))).toBe(400);
    expect(await statusOf(watches.create({ url: 'https://x', kind: 'changed', intervalSeconds: 10 }))).toBe(400);
    const w = await watches.create({ url: 'https://x', kind: 'changed', intervalSeconds: 60 });
    expect(w.nextRunAt).toBe(1_000_000);
  });
});

describe('Watches.observe changed', () => {
  it('fires only on new content, suppresses repeats', async () => {
    const watches = setup();
    const w = await watches.create({ url: 'https://x', kind: 'changed', intervalSeconds: 60 });
    const first = await watches.observe(w.id, 'hello');
    expect(first.fired).toBe(false);
    const second = await watches.observe(w.id, 'hello world');
    expect(second.fired).toBe(true);
    expect(second.alert?.url).toBe('https://x');
    const third = await watches.observe(w.id, 'hello world');
    expect(third.fired).toBe(false);
    expect(third.alert).toBeNull();
    expect(await watches.alerts()).toHaveLength(1);
  });
});

describe('Watches.observe contains + priceBelow', () => {
  it('fires on absent->present transition only', async () => {
    const watches = setup();
    const w = await watches.create({ url: 'https://x', kind: 'contains', needle: 'open', intervalSeconds: 60 });
    expect((await watches.observe(w.id, 'closed today')).fired).toBe(false);
    expect((await watches.observe(w.id, 'we are open')).fired).toBe(true);
    expect((await watches.observe(w.id, 'still open')).fired).toBe(false);
  });

  it('fires when the price drops below threshold', async () => {
    const watches = setup();
    const w = await watches.create({ url: 'https://x', kind: 'priceBelow', threshold: 30, intervalSeconds: 60 });
    expect((await watches.observe(w.id, 'tickets $45')).fired).toBe(false);
    const hit = await watches.observe(w.id, 'tickets $25');
    expect(hit.fired).toBe(true);
    expect(hit.alert?.excerpt).toContain('$25');
  });
});

describe('Watches scheduling', () => {
  it('lists due watches and backs off on failure', async () => {
    let now = 1_000_000;
    const watches = setup(() => now);
    const w = await watches.create({ url: 'https://x', kind: 'changed', intervalSeconds: 60 });
    expect(await watches.due()).toHaveLength(1);
    now += 1000;
    await watches.observe(w.id, 'v1');
    expect(await watches.due()).toHaveLength(0);
    await watches.pause(w.id);
    now += 3600_000;
    expect(await watches.due()).toHaveLength(0);
    await watches.resume(w.id);
    expect(await watches.due()).toHaveLength(1);
    const failed = await watches.fail(w.id);
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.nextRunAt).toBe(now + backoffMs(60, 1));
  });
});
