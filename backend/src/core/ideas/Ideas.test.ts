/**
 * Ideas + Notifications tests — offline, :memory: RecordsStore.
 */
import { SqliteRecordsStore } from '../store/RecordsStore';
import { Ideas } from './Ideas';

const OWNER = 'test-owner';

function setup(): Ideas {
  return new Ideas(new SqliteRecordsStore({ dbPath: ':memory:' }), OWNER);
}

describe('Ideas', () => {
  it('suggests and lists pending ideas', async () => {
    const ideas = setup();
    await ideas.suggest({ text: 'Visit Tue', sources: ['mail-1'], rule: 'mail-goal' });
    expect(await ideas.pending()).toHaveLength(1);
  });

  it('accepted and dismissed ideas never resurface', async () => {
    const ideas = setup();
    const a = await ideas.suggest({ text: 'a' });
    const b = await ideas.suggest({ text: 'b' });
    await ideas.accept(a.id);
    await ideas.dismiss(b.id);
    expect(await ideas.pending()).toHaveLength(0);
  });

  it('edits pending text but not decided ideas', async () => {
    const ideas = setup();
    const a = await ideas.suggest({ text: 'a' });
    expect((await ideas.edit(a.id, 'a2')).text).toBe('a2');
    await ideas.dismiss(a.id);
    await expect(ideas.edit(a.id, 'a3')).rejects.toThrow();
  });
});
