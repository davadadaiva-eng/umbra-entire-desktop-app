import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { VectorToolRegistry, Embedder } from './VectorToolRegistry';
import { ToolDefinition, makeToolId } from './ToolDefinition';

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-vec-'));
  return path.join(dir, 'tool-vectors.db');
}

function def(connector: string, name: string, description: string): ToolDefinition {
  return {
    tool_id: makeToolId(connector, name),
    connector_id: connector,
    name,
    natural_language_description: description,
    category: 'Test',
    parameters_schema: { type: 'object', properties: {}, required: [] },
    auth_type: 'none',
    transport: 'rest',
    schema_quality: 'curated',
  };
}

/** Deterministic bag-of-words embedder — same words ⇒ same vector. */
const fakeEmbed: Embedder = async text => {
  const words = ['email', 'send', 'calendar', 'event', 'create', 'song', 'play', 'music', 'invoice', 'payment'];
  const vec = new Array(words.length).fill(0);
  const lower = text.toLowerCase();
  words.forEach((w, i) => {
    if (lower.includes(w)) vec[i] = 1;
  });
  return vec;
};

describe('VectorToolRegistry', () => {
  let dbPath: string;
  let registry: VectorToolRegistry;

  beforeEach(() => {
    dbPath = tmpDb();
    registry = new VectorToolRegistry(dbPath, { embedder: fakeEmbed });
  });

  afterEach(() => {
    registry.close();
  });

  it('ranks semantically relevant tools first', async () => {
    const defs = [
      def('mail', 'send_email', 'Send an email to someone'),
      def('cal', 'create_event', 'Create a calendar event'),
      def('music', 'play_song', 'Play a song on the music player'),
      def('pay', 'create_invoice', 'Create an invoice for a payment'),
    ];
    await registry.index(defs);

    const hits = await registry.search('send an email to bob', 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].def.tool_id).toBe('mail.send_email');
    expect(hits[0].source).toBe('vector');

    const musicHits = await registry.search('play some music', 1);
    expect(musicHits[0].def.tool_id).toBe('music.play_song');
  });

  it('caches embeddings by text hash (second index is a no-op)', async () => {
    const defs = [def('mail', 'send_email', 'Send an email to someone')];
    await registry.index(defs);
    await registry.index(defs); // unchanged → nothing re-embedded
    expect(registry.status().indexed).toBe(1);
  });

  it('falls back to keyword scoring when the embedder fails at query time', async () => {
    const defs = [
      def('mail', 'send_email', 'Send an email to someone'),
      def('cal', 'create_event', 'Create a calendar event'),
    ];
    await registry.index(defs);

    const broken = new VectorToolRegistry(dbPath, {
      embedder: async () => { throw new Error('provider down'); },
      keywordSearch: (q, limit) =>
        defs
          .filter(d => d.natural_language_description.toLowerCase().includes(q.split(' ')[0].toLowerCase()))
          .slice(0, limit),
    });
    const hits = await broken.search('email', 3);
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe('keyword');
    expect(hits[0].def.tool_id).toBe('mail.send_email');
    broken.close();
  });

  it('starts in keyword mode when no embedder is configured', async () => {
    const noEmbed = new VectorToolRegistry(dbPath, {});
    noEmbed.registerDefinitions([def('mail', 'send_email', 'Send an email to someone')]);
    const status = noEmbed.status();
    expect(status.mode).toBe('keyword');
    expect(status.embedder).toBe(false);
    const hits = await noEmbed.search('send an email', 3);
    // Internal token-overlap fallback still finds it by name/description.
    expect(hits.some(h => h.def.tool_id === 'mail.send_email')).toBe(true);
    noEmbed.close();
  });

  it('filters by connector', async () => {
    const defs = [
      def('mail', 'send_email', 'Send an email'),
      def('mail', 'read_email', 'Read an email'),
      def('cal', 'create_event', 'Create an event'),
    ];
    await registry.index(defs);
    const hits = await registry.search('email event anything', 10, { connectorId: 'cal' });
    expect(hits.every(h => h.def.connector_id === 'cal')).toBe(true);
  });

  it('persists vectors across restarts (no re-embedding needed)', async () => {
    const defs = [def('mail', 'send_email', 'Send an email to someone')];
    await registry.index(defs);
    registry.close();

    const reopened = new VectorToolRegistry(dbPath, { embedder: fakeEmbed });
    // Definitions must be re-registered (vectors alone have no schemas)…
    reopened.registerDefinitions(defs);
    const hits = await reopened.search('send an email', 1);
    expect(hits[0].def.tool_id).toBe('mail.send_email');
    reopened.close();
  });
});
