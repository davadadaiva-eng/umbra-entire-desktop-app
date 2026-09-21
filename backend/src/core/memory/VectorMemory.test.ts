import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { VectorMemory, cosineSimilarity } from './VectorMemory';

function tmpDb(name: string): string {
  const dir = path.join(os.tmpdir(), `umbra-vmem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function fakeEmbed(text: string): Promise<number[]> {
  return Promise.resolve(fakeEmbedSync(text));
}

function fakeEmbedSync(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const vec = Array.from({ length: 676 }, () => 0);
  for (const w of words) {
    const key = w.replace(/[^a-z]/g, '');
    if (!key) continue;
    const a = key.charCodeAt(0) - 97;
    const b = key.length > 1 ? key.charCodeAt(1) - 97 : 0;
    if (a < 0 || a > 25 || b < 0 || b > 25) continue;
    vec[a * 26 + b] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(v => v / norm);
}

describe('VectorMemory', () => {
  let memory: VectorMemory;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb('test.db');
    memory = new VectorMemory(dbPath, { embed: fakeEmbed });
    memory.initialize();
  });

  afterEach(() => {
    memory.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('inserts and retrieves vectors', async () => {
    const id = await memory.addVector('note', 'n1', 'user likes dark mode and keyboard shortcuts');
    expect(id).toBeGreaterThan(0);
    expect(memory.getVectorCount('note')).toBe(1);
    expect(memory.getVectorCount()).toBe(1);
  });

  it('searches similar text semantically', async () => {
    await memory.addVector('note', 'n1', 'user prefers dark theme in their code editor');
    await memory.addVector('note', 'n2', 'invoice for the F24 tax payment');
    await memory.addVector('note', 'n3', 'remember to file quarterly VAT returns');
    const results = await memory.searchSimilar('dark mode theme preference', { k: 3, kind: 'note' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].refId).toBe('n1');
    expect(results[0].distance).toBeLessThanOrEqual(1);
  });

  it('keeps vectors across a DB reopen (restart) — regression: index was dropped', async () => {
    const reopenPath = tmpDb('reopen.db');
    const first = new VectorMemory(reopenPath, { embed: fakeEmbed });
    first.initialize();
    await first.addVector('note', 'n1', 'user prefers dark theme in their code editor');
    await first.addVector('note', 'n2', 'invoice for the F24 tax payment');
    first.close();

    // Simulate an app restart: new instance over the same file. The vector
    // table must survive (previously ensureVecTable dropped it on first use).
    const second = new VectorMemory(reopenPath, { embed: fakeEmbed });
    second.initialize();
    const results = await second.searchSimilar('dark mode theme preference', { k: 3, kind: 'note' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].refId).toBe('n1');
    expect(second.getVectorCount('note')).toBe(2);
    second.close();
  });

  it('falls back to text search when embedding is absent', async () => {
    const noEmbed = new VectorMemory(tmpDb('noembed.db'));
    noEmbed.initialize();
    await noEmbed.addVector('note', 'x1', 'hello world');
    const hits = noEmbed.searchText('world', { kind: 'note' });
    expect(hits.length).toBe(1);
    expect(hits[0].refId).toBe('x1');
    noEmbed.close();
  });

  it('mirrors the recall activity API', () => {
    const id = memory.logUserActivity({
      appName: 'notepad',
      windowTitle: 'notes.txt',
      action: 'focus',
      contextTags: 'writing',
      durationSec: 5,
      keystrokeCount: 10,
      clickCount: 2,
      scrollCount: 0,
      isActive: true,
      sessionId: 's1',
      hourOfDay: 10,
      dayOfWeek: 1,
    });
    expect(id).toBeGreaterThan(0);
    const activities = memory.getUserActivity({ appName: 'notepad' });
    expect(activities.length).toBe(1);
    expect(activities[0].appName).toBe('notepad');
    const summary = memory.getActivitySummary();
    expect(summary.totalEntries).toBe(1);
    expect(summary.uniqueApps).toBe(1);
  });

  it('tracks sessions and macros', () => {
    memory.startSession('s1');
    memory.endSession('s1', 120, 3);
    const sessions = memory.getSessions();
    expect(sessions.length).toBe(1);

    memory.saveMacro({
      triggerKeyword: 'daily-report',
      detectedPattern: 'navigate -> extract -> type',
      steps: [{ action: 'navigate', params: { url: 'x' }, description: 'go' }],
      executionCount: 1,
    });
    expect(memory.getMacro('daily-report')?.triggerKeyword).toBe('daily-report');
    expect(memory.getAllMacros().length).toBe(1);
  });

  it('computes cosine similarity correctly', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });
});
