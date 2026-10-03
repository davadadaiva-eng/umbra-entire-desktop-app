/**
 * Pages tests — offline, :memory: RecordsStore. No routes wired.
 */
import { SqliteRecordsStore } from '../store/RecordsStore';
import { Pages, PageError } from './Pages';

const OWNER = 'test-owner';
const spaceExists = (id: string) => id !== 'missing';

function setup(): Pages {
  const store = new SqliteRecordsStore({ dbPath: ':memory:' });
  return new Pages(store, OWNER, spaceExists);
}

function statusOf(p: Promise<unknown>): Promise<number | null> {
  return p.then(
    () => null,
    (err) => {
      expect(err).toBeInstanceOf(PageError);
      return (err as PageError).status;
    },
  );
}

describe('Pages.create/get/list', () => {
  it('creates and reads back a page at revision 1', async () => {
    const pages = setup();
    const page = await pages.create('s1', { title: 'Rome', content: 'trip' });
    expect(page.revision).toBe(1);
    expect((await pages.get('s1', page.id)).title).toBe('Rome');
    expect(await pages.list('s1')).toHaveLength(1);
  });

  it('rejects empty titles and missing spaces', async () => {
    const pages = setup();
    expect(await statusOf(pages.create('s1', { title: '  ' }))).toBe(400);
    expect(await statusOf(pages.create('missing', { title: 'x' }))).toBe(404);
    expect(await statusOf(pages.get('s1', 'nope'))).toBe(404);
  });

  it('rejects parent cycles', async () => {
    const pages = setup();
    const parent = await pages.create('s1', { title: 'p' });
    const child = await pages.create('s1', { title: 'c', parentId: parent.id });
    expect(
      await statusOf(
        pages.update('s1', parent.id, { parentId: child.id, expectedRevision: 1 }),
      ),
    ).toBe(400);
    expect(
      await statusOf(
        pages.update('s1', parent.id, { parentId: parent.id, expectedRevision: 1 }),
      ),
    ).toBe(400);
  });
});

describe('Pages.update revision guard', () => {
  it('applies edits with the current revision', async () => {
    const pages = setup();
    const page = await pages.create('s1', { title: 'a' });
    const next = await pages.update('s1', page.id, { title: 'b', expectedRevision: 1 });
    expect(next.revision).toBe(2);
    expect(next.title).toBe('b');
  });

  it('returns 409 on stale expectedRevision', async () => {
    const pages = setup();
    const page = await pages.create('s1', { title: 'a' });
    await pages.update('s1', page.id, { title: 'b', expectedRevision: 1 });
    expect(
      await statusOf(pages.update('s1', page.id, { title: 'c', expectedRevision: 1 })),
    ).toBe(409);
  });
});

describe('Pages.createReviewed idempotency', () => {
  it('returns the same page for the same toolCallId', async () => {
    const pages = setup();
    const a = await pages.createReviewed('s1', { title: 'draft' }, 't1', 'call1');
    const b = await pages.createReviewed('s1', { title: 'draft' }, 't1', 'call1');
    expect(b.id).toBe(a.id);
    expect(await pages.list('s1')).toHaveLength(1);
  });

  it('returns 409 when the same review targets another Space', async () => {
    const pages = setup();
    await pages.createReviewed('s1', { title: 'draft' }, 't1', 'call1');
    expect(
      await statusOf(pages.createReviewed('s2', { title: 'draft' }, 't1', 'call1')),
    ).toBe(409);
  });
});

describe('Pages thread leases', () => {
  it('reserves, finishes, and resolves forThread', async () => {
    const pages = setup();
    const page = await pages.create('s1', { title: 'doc' });
    expect(await pages.reserveThread(page.id, 'dot1', 'thread1')).toBe(true);
    expect(await pages.reserveThread(page.id, 'dot1', 'thread2')).toBe(false);
    expect(await pages.forThread('thread1')).toBeUndefined();
    await pages.finishThread(page.id, 'dot1');
    expect((await pages.forThread('thread1'))?.id).toBe(page.id);
  });
});
