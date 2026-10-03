/**
 * Notifications tests — offline, :memory: RecordsStore.
 */
import { SqliteRecordsStore } from '../store/RecordsStore';
import { Notifications } from './Notifications';

const OWNER = 'test-owner';

function setup(): Notifications {
  return new Notifications(new SqliteRecordsStore({ dbPath: ':memory:' }), OWNER);
}

describe('Notifications', () => {
  it('notifies, lists unread newest-first, marks read', async () => {
    const inbox = setup();
    const first = await inbox.notify({ title: 'Price dropped' });
    const second = await inbox.notify({ title: 'Page changed', sourceLink: 'https://x' });
    const unread = await inbox.unread();
    expect(unread.map((n) => n.id)).toEqual([second.id, first.id]);
    await inbox.markRead(second.id);
    expect(await inbox.unread()).toHaveLength(1);
    expect(await inbox.reconcile()).toEqual({ pending: 1 });
  });

  it('rejects empty titles and unknown ids', async () => {
    const inbox = setup();
    await expect(inbox.notify({ title: '  ' })).rejects.toThrow();
    await expect(inbox.markRead('nope')).rejects.toThrow();
  });
});
