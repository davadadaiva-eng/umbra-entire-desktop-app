import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MeetingStore, PersistedMeeting } from './MeetingStore';

let store: MeetingStore;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-meetingstore-'));

beforeAll(() => { store = new MeetingStore(testDir); });
afterAll(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

const fakeMeeting: PersistedMeeting = {
  id: 'mtg-001',
  url: 'https://meet.google.com/abc-defg-hij',
  title: 'Sprint Planning',
  startedAt: '2026-01-01T10:00:00Z',
  endedAt: '2026-01-01T11:00:00Z',
  attendees: ['alice@example.com', 'bob@example.com'],
  transcript: [
    { speaker: 'Alice', text: 'Welcome everyone', atMs: 0 },
    { speaker: 'Bob', text: 'Let us begin', atMs: 5000 },
  ],
  summary: 'Discussed sprint goals for Q1.',
  actionItems: ['Alice to finalize roadmap', 'Bob to prepare demo'],
  decisions: ['Use React for frontend'],
};

describe('MeetingStore', () => {
  it('saves and retrieves a meeting', () => {
    store.save(fakeMeeting);
    const retrieved = store.get('mtg-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Sprint Planning');
    expect(retrieved!.attendees).toHaveLength(2);
    expect(retrieved!.transcript).toHaveLength(2);
  });

  it('returns null for non-existent meeting', () => {
    expect(store.get('mtg-nonexistent')).toBeNull();
  });

  it('lists meetings (most recent first)', () => {
    store.save({ ...fakeMeeting, id: 'mtg-002', title: 'Second Meeting' });
    store.save({ ...fakeMeeting, id: 'mtg-003', title: 'Third Meeting' });
    const list = store.list(2);
    expect(list).toHaveLength(2);
    // Most recent first (by filename sort)
    expect(list[0].id).toBe('mtg-003');
  });

  it('deletes a meeting', () => {
    store.save({ ...fakeMeeting, id: 'mtg-del', title: 'To Delete' });
    expect(store.get('mtg-del')).not.toBeNull();
    expect(store.delete('mtg-del')).toBe(true);
    expect(store.get('mtg-del')).toBeNull();
  });

  it('returns false when deleting non-existent', () => {
    expect(store.delete('mtg-nope')).toBe(false);
  });

  it('handles corrupt JSON files gracefully', () => {
    const corruptPath = path.join(testDir, 'meetings', 'mtg-corrupt.json');
    fs.writeFileSync(corruptPath, '{bad json', 'utf-8');
    const list = store.list();
    // Corrupt files are skipped, not included in results
    expect(list.find(m => m.id === 'mtg-corrupt')).toBeUndefined();
  });
});
