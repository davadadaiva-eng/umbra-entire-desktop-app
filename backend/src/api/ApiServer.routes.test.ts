/**
 * Route coverage for every ApiServer endpoint that `ApiServer.test.ts` did not
 * exercise.
 *
 * The original suite covered the LLM/billing/MCP/telco/docker spine and left
 * the rest of the ~200-entry route map unverified — task lifecycle, worker
 * leases, action proposals, input requests, meetings, connectors, social,
 * smart home, vault, carousel, Twenty CRM, devices, Chrome extension, screen
 * and audio. This file walks that surface.
 *
 * Each test asserts the response *shape* AND, where it matters, that the
 * request arguments reached the dependency unmangled (via the `calls` log on
 * the fixture).
 */
import { ApiServer } from './ApiServer';
import { makeFullDeps, type FullDeps } from './testkit';

const PORT = 39000 + Math.floor(Math.random() * 4000);

let deps: FullDeps;
let server: ApiServer;

async function api(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** The single recorded call to `fn`, asserting it happened exactly once. */
function callTo(fn: string, index = 0) {
  const matches = deps.calls.filter(c => c.fn === fn);
  expect(matches.length).toBeGreaterThan(index);
  return matches[index].args;
}

beforeAll(() => {
  deps = makeFullDeps();
  server = new ApiServer(deps as any, PORT);
  server.start();
});

afterAll(async () => {
  await server.stop();
});

// ── Task lifecycle ─────────────────────────────────────────────────

describe('task lifecycle', () => {
  test('GET /api/tasks lists the active queue', async () => {
    const res = await api('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.json.tasks).toHaveLength(1);
    expect(res.json.tasks[0].status).toBe('executing');
  });

  test('POST /api/task forwards priority and idempotencyKey', async () => {
    const res = await api('/api/task', 'POST', { description: 'ship it', priority: 3, idempotencyKey: 'k-1' });
    expect(res.status).toBe(200);
    expect(res.json.taskId).toBe('task-7');
    expect(callTo('submitTask')).toEqual(['ship it', 3, 'k-1']);
  });

  test('POST /api/task defaults priority to 0 and omits an absent idempotencyKey', async () => {
    await api('/api/task', 'POST', { description: 'hi' });
    expect(callTo('submitTask', 1)).toEqual(['hi', 0, undefined]);
  });

  test('POST /api/task treats a whitespace-only description as missing', async () => {
    const res = await api('/api/task', 'POST', { description: '   ' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/description is required/);
  });

  test('GET /api/task/:id/activity returns the activity feed', async () => {
    const res = await api('/api/task/t-9/activity');
    expect(res.status).toBe(200);
    expect(res.json.activity[0].taskId).toBe('t-9');
  });

  test('POST /api/task/:id/cancel returns the cancelled id', async () => {
    const res = await api('/api/task/t-9/cancel', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.cancelled).toBe('t-9');
    expect(callTo('cancelTask')).toEqual(['t-9']);
  });

  test('POST /api/task/:id/retry prefers the id returned by the runtime', async () => {
    const res = await api('/api/task/t-9/retry', 'POST', { description: 'try harder' });
    expect(res.status).toBe(200);
    expect(res.json.taskId).toBe('t-9-retry');
    expect(callTo('retryTask')).toEqual(['t-9', 'try harder']);
  });

  test('POST /api/task/:id/retry works without a new description', async () => {
    const res = await api('/api/task/t-9/retry', 'POST', {});
    expect(res.status).toBe(200);
    expect(callTo('retryTask', 1)).toEqual(['t-9', undefined]);
  });

  test('POST /api/chat dispatches to the requested target', async () => {
    const res = await api('/api/chat', 'POST', { message: 'hello', target: 'desktop' });
    expect(res.status).toBe(200);
    expect(res.json.dispatch.taskId).toBe('task-chat');
    expect(callTo('chat')).toEqual(['hello', 'desktop']);
  });

  test('POST /api/chat defaults the target to auto', async () => {
    await api('/api/chat', 'POST', { message: 'hi' });
    expect(callTo('chat', 1)).toEqual(['hi', 'auto']);
  });

  test('POST /api/chat accepts the `text` alias', async () => {
    const res = await api('/api/chat', 'POST', { text: 'aliased' });
    expect(res.status).toBe(200);
    expect(callTo('chat', 2)).toEqual(['aliased', 'auto']);
  });

  test('POST /api/chat requires a message', async () => {
    const res = await api('/api/chat', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/message is required/);
  });
});

// ── Worker leases ──────────────────────────────────────────────────

describe('worker lease endpoints', () => {
  test('POST /api/worker/claim returns the lease', async () => {
    const res = await api('/api/worker/claim', 'POST', { taskId: 't', workerId: 'w' });
    expect(res.status).toBe(200);
    expect(res.json.task.lease).toBe('l1');
  });

  test('POST /api/worker/heartbeat reports ok', async () => {
    const res = await api('/api/worker/heartbeat', 'POST', { taskId: 't', workerId: 'w' });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  test('POST /api/worker/release is idempotent and always ok', async () => {
    const res = await api('/api/worker/release', 'POST', { taskId: 't', workerId: 'w' });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  test('POST /api/worker/recover reclaims the tasks of a dead worker', async () => {
    const res = await api('/api/worker/recover', 'POST', { workerId: 'w-dead' });
    expect(res.status).toBe(200);
    expect(res.json.reclaimed[0].workerId).toBe('w-dead');
  });

  test.each([
    ['/api/worker/claim', { workerId: 'w' }],
    ['/api/worker/heartbeat', { taskId: 't' }],
    ['/api/worker/release', { taskId: 't' }],
  ])('%s requires both taskId and workerId', async (path, body) => {
    const res = await api(path, 'POST', body);
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/taskId and workerId/);
  });

  test('/api/worker/recover requires a workerId', async () => {
    const res = await api('/api/worker/recover', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/workerId required/);
  });
});

// ── Action proposals + input requests ──────────────────────────────

describe('action proposals', () => {
  test('POST /api/actions/propose records the exact args', async () => {
    const res = await api('/api/actions/propose', 'POST', { taskId: 't-1', action: 'delete-file', args: { path: 'a.txt' } });
    expect(res.status).toBe(200);
    expect(res.json.proposal.id).toBe('prop-1');
    expect(callTo('proposeAction')).toEqual(['t-1', 'delete-file', { path: 'a.txt' }]);
  });

  test('POST /api/actions/propose defaults args to {}', async () => {
    await api('/api/actions/propose', 'POST', { taskId: 't-1', action: 'noop' });
    expect(callTo('proposeAction', 1)).toEqual(['t-1', 'noop', {}]);
  });

  test('POST /api/actions/review carries the consent hash', async () => {
    const res = await api('/api/actions/review', 'POST', { proposalId: 'prop-1', approved: true, hash: 'h1' });
    expect(res.status).toBe(200);
    expect(res.json.result.executed).toBe(true);
    expect(callTo('reviewAction')).toEqual(['prop-1', true, 'h1']);
  });

  test('a rejected review reports approved: false and executed: false', async () => {
    const res = await api('/api/actions/review', 'POST', { proposalId: 'prop-1', approved: false, hash: 'h1' });
    expect(res.status).toBe(200);
    expect(res.json.result.executed).toBe(false);
  });

  test('POST /api/actions/review requires the hash (tamper check)', async () => {
    const res = await api('/api/actions/review', 'POST', { proposalId: 'prop-1', approved: true });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/proposalId and hash required/);
  });

  test('GET /api/actions/proposal/:id returns one proposal', async () => {
    const res = await api('/api/actions/proposal/prop-9');
    expect(res.status).toBe(200);
    expect(res.json.proposal.hash).toBe('h1');
  });

  test('GET /api/task/:id/proposals lists the task proposals', async () => {
    const res = await api('/api/task/t-1/proposals');
    expect(res.status).toBe(200);
    expect(res.json.proposals).toHaveLength(1);
  });
});

describe('waiting_input pause/resume', () => {
  test('POST /api/task/:id/input opens an input request with options', async () => {
    const res = await api('/api/task/t-1/input', 'POST', { question: 'Which env?', options: ['dev', 'prod'] });
    expect(res.status).toBe(200);
    expect(res.json.inputRequest).toMatchObject({ id: 'in-1', question: 'Which env?', options: ['dev', 'prod'] });
  });

  test('POST /api/task/:id/input requires a question', async () => {
    const res = await api('/api/task/t-1/input', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/question required/);
  });

  test('POST /api/input/:id/answer routes by the taskId in the body', async () => {
    const res = await api('/api/input/in-1/answer', 'POST', { taskId: 't-1', answer: 'prod' });
    expect(res.status).toBe(200);
    expect(res.json.result).toEqual({ taskId: 't-1', inputId: 'in-1', answer: 'prod' });
  });

  test('POST /api/input/:id/answer requires a taskId to route by', async () => {
    const res = await api('/api/input/in-1/answer', 'POST', { answer: 'prod' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/taskId required/);
  });
});

// ── Journal / skills / shutdown ────────────────────────────────────

describe('journal, skills, shutdown', () => {
  test('POST /api/journal/generate runs now', async () => {
    const res = await api('/api/journal/generate', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.journal.ok).toBe(true);
  });

  test('POST /api/skills/compile-hot accepts a threshold', async () => {
    const res = await api('/api/skills/compile-hot', 'POST', { threshold: 5 });
    expect(res.status).toBe(200);
    expect(res.json.compiled).toEqual({ compiled: 2, threshold: 5 });
  });

  test('POST /api/skills/compile-hot defaults the threshold', async () => {
    const res = await api('/api/skills/compile-hot', 'POST', {});
    expect(res.json.compiled.threshold).toBe(3);
  });

  test('POST /api/shutdown signals the runtime', async () => {
    const res = await api('/api/shutdown', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(callTo('shutdown')).toEqual([]);
  });
});

// ── Ghost + screen ─────────────────────────────────────────────────

describe('ghost and screen', () => {
  test('POST /api/ghost/action executes on the ghost desktop', async () => {
    const res = await api('/api/ghost/action', 'POST', { action: 'click', params: { x: 1, y: 2 } });
    expect(res.status).toBe(200);
    expect(res.json.result).toContain('ghost click');
  });

  test('POST /api/ghost/action requires an action', async () => {
    const res = await api('/api/ghost/action', 'POST', { params: {} });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/action is required/);
  });

  test('GET /api/ghost/capture returns the png payload', async () => {
    const res = await api('/api/ghost/capture');
    expect(res.status).toBe(200);
    expect(res.json.image).toBe('iVBORw0KGgo=');
  });

  test('GET /api/screen/state reports the current display', async () => {
    const res = await api('/api/screen/state');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ width: 1920, height: 1080, watching: false });
  });

  test('GET /api/screen/live returns a frame', async () => {
    const res = await api('/api/screen/live');
    expect(res.status).toBe(200);
    expect(res.json.frame).toBe('AAAA');
  });

  test('POST /api/screen/watch toggles watching', async () => {
    expect((await api('/api/screen/watch', 'POST', { enabled: true })).json.watching).toBe(true);
    expect((await api('/api/screen/watch', 'POST', { enabled: false })).json.watching).toBe(false);
  });

  test('POST /api/screen/watch defaults to enabled when the flag is absent', async () => {
    expect((await api('/api/screen/watch', 'POST', {})).json.watching).toBe(true);
  });

  test('POST /api/screen/ask defaults the intent to answer', async () => {
    const res = await api('/api/screen/ask', 'POST', { question: 'what colour?' });
    expect(res.status).toBe(200);
    expect(res.json.intent).toBe('answer');
    expect(res.json.answer).toBe('blue');
  });

  test('POST /api/screen/ask honours an explicit intent', async () => {
    const res = await api('/api/screen/ask', 'POST', { question: 'read this', intent: 'act' });
    expect(res.json.intent).toBe('act');
  });

  test('POST /api/screen/ask requires a question', async () => {
    const res = await api('/api/screen/ask', 'POST', {});
    expect(res.status).toBe(500);
  });
});

// ── Chrome extension ───────────────────────────────────────────────

describe('chrome extension', () => {
  test('POST /api/chrome/telemetry ingests a batch and its cookie snapshot', async () => {
    const res = await api('/api/chrome/telemetry', 'POST', {
      events: [{ url: 'https://a.b' }, { url: 'https://c.d' }],
      sessionId: 'sess-1',
      cookieSnapshot: { count: 12 },
    });
    expect(res.status).toBe(200);
    expect(res.json.ingested).toBe(2);
    expect(callTo('handleChromeTelemetry')[1]).toBe('sess-1');
  });

  test('POST /api/chrome/telemetry tolerates a missing events array', async () => {
    const res = await api('/api/chrome/telemetry', 'POST', { sessionId: 'sess-2' });
    expect(res.status).toBe(200);
    expect(res.json.ingested).toBe(0);
  });

  test('GET /api/chrome/status reports the connection', async () => {
    const res = await api('/api/chrome/status');
    expect(res.json).toEqual({ connected: true, version: '1.4.0' });
  });

  test('GET /api/chrome/logins lists detected login events', async () => {
    const res = await api('/api/chrome/logins');
    expect(res.json[0].provider).toBe('google');
  });

  test('POST /api/chrome/logins/approve saves the credential', async () => {
    const res = await api('/api/chrome/logins/approve', 'POST', {
      url: 'https://accounts.google.com',
      provider: 'google',
      username: 'alex',
    });
    expect(res.status).toBe(200);
    expect(res.json.approved.approved).toBe(true);
  });

  test('POST /api/chrome/logins/approve requires both url and provider', async () => {
    const res = await api('/api/chrome/logins/approve', 'POST', { url: 'https://x' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/url and provider are required/);
  });

  test('GET /api/chrome/cookies filters by domain', async () => {
    const res = await api('/api/chrome/cookies?domain=github.com');
    expect(res.status).toBe(200);
    expect(res.json.cookies[0].domain).toBe('github.com');
  });

  test('GET /api/chrome/cookies masks the cookie value', async () => {
    const res = await api('/api/chrome/cookies');
    expect(res.json.cookies[0].value).toBe('***');
  });

  test('GET /api/chrome/sites lists history', async () => {
    const res = await api('/api/chrome/sites');
    expect(res.json.sites[0].host).toBe('example.com');
  });
});

// ── Audio + meetings ───────────────────────────────────────────────

describe('audio recording', () => {
  test('POST /api/audio/loopback/start honours an explicit duration', async () => {
    const res = await api('/api/audio/loopback/start', 'POST', { seconds: 12 });
    expect(res.status).toBe(200);
    expect(res.json.recording.seconds).toBe(12);
  });

  test('POST /api/audio/loopback/start defaults the duration', async () => {
    const res = await api('/api/audio/loopback/start', 'POST', {});
    expect(res.json.recording.seconds).toBe(5);
  });

  test('POST /api/audio/loopback/stop requires the recording id', async () => {
    const res = await api('/api/audio/loopback/stop', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/id is required/);
  });

  test('POST /api/audio/loopback/stop returns the stopped recording', async () => {
    const res = await api('/api/audio/loopback/stop', 'POST', { id: 'loop-1' });
    expect(res.json.recording).toEqual({ id: 'loop-1', stopped: true });
  });

  test('GET /api/audio/recordings lists past loops', async () => {
    const res = await api('/api/audio/recordings');
    expect(res.json.recordings[0].id).toBe('loop-1');
  });

  test('POST /api/audio/set-default defaults the flow to render', async () => {
    const res = await api('/api/audio/set-default', 'POST', { deviceId: 'd1' });
    expect(res.json.result).toBe('set render d1');
  });
});

describe('meetings', () => {
  test('GET /api/meetings lists meetings', async () => {
    const res = await api('/api/meetings');
    expect(res.json.meetings[0].id).toBe('m1');
  });

  test('GET /api/meetings/:id returns one meeting', async () => {
    const res = await api('/api/meetings/m9');
    expect(res.json.meeting.title).toBe('Meeting m9');
  });

  test('POST /api/meeting/join forwards title and topics', async () => {
    const res = await api('/api/meeting/join', 'POST', {
      url: 'https://zoom.us/j/1',
      title: 'Standup',
      topics: ['sprint'],
    });
    expect(res.status).toBe(200);
    expect(res.json.meeting).toMatchObject({ url: 'https://zoom.us/j/1', title: 'Standup', topics: ['sprint'] });
  });

  test('POST /api/meeting/join requires a url', async () => {
    const res = await api('/api/meeting/join', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/url is required/);
  });

  test('POST /api/meeting/listen starts transcription', async () => {
    const res = await api('/api/meeting/listen', 'POST');
    expect(res.json.listening).toBe(true);
  });

  test('GET /api/meeting/status reports the active platform', async () => {
    const res = await api('/api/meeting/status');
    expect(res.json).toEqual({ active: true, platform: 'zoom' });
  });

  test('POST /api/meeting/leave ends the meeting', async () => {
    const res = await api('/api/meeting/leave', 'POST');
    expect(res.json.meeting.left).toBe(true);
  });

  test('POST /api/meeting/execute forwards action + params', async () => {
    const res = await api('/api/meeting/execute', 'POST', { action: 'share', params: { target: 'window' } });
    expect(res.json).toEqual({ action: 'share', params: { target: 'window' } });
  });

  test('POST /api/meeting/execute requires an action', async () => {
    const res = await api('/api/meeting/execute', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('POST /api/meeting/audio reports the segment size', async () => {
    const res = await api('/api/meeting/audio', 'POST', { audio: 'QUJDRA==', format: 'wav' });
    expect(res.status).toBe(200);
    expect(res.json.segment).toEqual({ bytes: 8, format: 'wav' });
  });

  test('POST /api/meeting/audio requires audio', async () => {
    const res = await api('/api/meeting/audio', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/audio \(base64\) is required/);
  });

  test('POST /api/meeting/share defaults the target to the screen', async () => {
    const res = await api('/api/meeting/share', 'POST', {});
    expect(res.json.result.target).toBe('screen');
  });

  test('POST /api/meeting/stop-share ends sharing', async () => {
    const res = await api('/api/meeting/stop-share', 'POST');
    expect(res.json.result.sharing).toBe(false);
  });

  test('GET /api/meeting/orders lists pending meeting orders', async () => {
    const res = await api('/api/meeting/orders');
    expect(res.json.orders[0].kind).toBe('summarize');
  });

  test('POST /api/meeting/speak forwards voice + language', async () => {
    const res = await api('/api/meeting/speak', 'POST', { text: 'hi team', voice: 'paola', language: 'it' });
    expect(res.status).toBe(200);
    expect(res.json.result.spoke).toBe('hi team');
  });

  test('POST /api/meeting/speak requires text', async () => {
    const res = await api('/api/meeting/speak', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('POST /api/meeting/mute defaults to muted when the flag is absent', async () => {
    const res = await api('/api/meeting/mute', 'POST', {});
    expect(res.json.result).toBe('mic muted');
  });

  test('POST /api/meeting/mute un-mutes on { muted: false }', async () => {
    const res = await api('/api/meeting/mute', 'POST', { muted: false });
    expect(res.json.result).toBe('mic unmuted');
  });

  test('POST /api/meeting/raise-hand defaults to raised', async () => {
    const res = await api('/api/meeting/raise-hand', 'POST', {});
    expect(res.json.result).toBe('hand raised');
  });
});

describe('meeting bot', () => {
  test('POST /api/meeting-bot/join defaults the platform and bot name', async () => {
    const res = await api('/api/meeting-bot/join', 'POST', { meeting_url: 'https://meet.google.com/abc' });
    expect(res.status).toBe(200);
    expect(res.json.bot).toEqual({ meetingUrl: 'https://meet.google.com/abc', platform: 'google_meet', botName: 'Umbra' });
  });

  test('POST /api/meeting-bot/join requires a meeting_url', async () => {
    const res = await api('/api/meeting-bot/join', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/meeting_url is required/);
  });

  test('the remaining meeting-bot routes respond', async () => {
    expect((await api('/api/meeting-bot/status')).json.bot.state).toBe('idle');
    expect((await api('/api/meeting-bot/transcript')).json.bot.segments[0].text).toBe('hello');
    // /leave is POST-only.
    expect((await api('/api/meeting-bot/leave', 'POST')).json.bot.left).toBe(true);
  });

  test('POST /api/meeting-bot/command forwards args', async () => {
    const res = await api('/api/meeting-bot/command', 'POST', { command: 'summarize', args: { lang: 'en' } });
    expect(res.json.bot).toEqual({ command: 'summarize', args: { lang: 'en' } });
  });

  test('POST /api/meeting-bot/command requires a command', async () => {
    const res = await api('/api/meeting-bot/command', 'POST', {});
    expect(res.status).toBe(500);
  });
});

// ── Knowledge / memory / observability ────────────────────────────

describe('knowledge, memory and observability read routes', () => {
  test('GET /api/knowledge/search echoes the query', async () => {
    const res = await api('/api/knowledge/search?q=vector');
    expect(res.json.results[0].title).toBe('vector');
  });

  test('GET /api/memory/recall echoes the query', async () => {
    const res = await api('/api/memory/recall?q=routing');
    expect(res.json.query).toBe('routing');
  });

  test('GET /api/macros lists macros', async () => {
    expect((await api('/api/macros')).json.macros[0].name).toBe('daily-standup');
  });

  test('GET /api/sessions lists sessions', async () => {
    expect((await api('/api/sessions')).json.sessions[0].id).toBe('s1');
  });

  test('GET /api/privacy/stats returns the redaction counters', async () => {
    expect((await api('/api/privacy/stats')).json.masked).toBe(3);
  });

  test('GET /api/activity/summary returns the day summary', async () => {
    expect((await api('/api/activity/summary')).json.tasks).toBe(4);
  });

  test('GET /api/swarm returns the swarm allocation', async () => {
    expect((await api('/api/swarm')).json.swarm.slots).toBe(2);
  });

  test('GET /api/vault/stats returns the audit stats', async () => {
    expect((await api('/api/vault/stats')).json.vault.entries).toBe(7);
  });
});

// ── Voice ──────────────────────────────────────────────────────────

describe('voice', () => {
  test('GET /api/voice/status reports the active engine', async () => {
    const res = await api('/api/voice/status');
    expect(res.json).toMatchObject({ stt: 'whisper', tts: 'piper', degraded: false });
  });

  test('GET /api/voice/tts/voices lists the installed voices', async () => {
    const res = await api('/api/voice/tts/voices');
    expect(res.json.voices[0].id).toBe('paola');
  });

  test('POST /api/voice/speak forwards provider and engine', async () => {
    const res = await api('/api/voice/speak', 'POST', { text: 'hello', provider: 'piper', engine: 'local' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ spoke: 'hello', provider: 'piper', engine: 'local', voice: undefined, language: undefined });
  });

  test('POST /api/voice/speak requires text', async () => {
    const res = await api('/api/voice/speak', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('POST /api/voice/transcribe returns the text', async () => {
    const res = await api('/api/voice/transcribe', 'POST', { audio: 'QUJD', language: 'it' });
    expect(res.status).toBe(200);
    expect(res.json.transcription).toEqual({ text: 'hello world', language: 'it' });
  });

  test('POST /api/voice/transcribe requires audio', async () => {
    const res = await api('/api/voice/transcribe', 'POST', {});
    expect(res.status).toBe(500);
  });
});

// ── Connectors ─────────────────────────────────────────────────────

describe('connector marketplace', () => {
  test('GET /api/connectors passes q / category / limit / offset through', async () => {
    const res = await api('/api/connectors?q=gmail&category=Communication&limit=5&offset=10');
    expect(res.status).toBe(200);
    expect(res.json.connectors).toMatchObject({ q: 'gmail', category: 'Communication', limit: 5, offset: 10 });
  });

  test('GET /api/connectors/categories is matched before the :id pattern', async () => {
    const res = await api('/api/connectors/categories');
    expect(res.status).toBe(200);
    expect(res.json.categories[0].id).toBe('communication');
  });

  test('GET /api/connectors/search pins limit to 50', async () => {
    const res = await api('/api/connectors/search?q=mail');
    expect(res.status).toBe(200);
    expect(res.json.connectors.q).toBe('mail');
    expect(res.json.connectors.limit).toBe(50);
  });

  test('GET /api/connectors/:id is not shadowed by /search or /categories', async () => {
    const res = await api('/api/connectors/gmail');
    expect(res.status).toBe(200);
    expect(res.json.connector.id).toBe('gmail');
  });

  test('POST /api/connectors/:id/connect saves an api key', async () => {
    const res = await api('/api/connectors/gmail/connect', 'POST', { apiKey: 'AKIA123' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: 'gmail', connected: true, apiKey: 'AKIA123' });
  });

  test('GET /api/connectors/:id/status forwards the userId filter', async () => {
    const res = await api('/api/connectors/gmail/status?userId=u-7');
    expect(res.json.status.userId).toBe('u-7');
  });

  test('GET /api/connectors/:id/status defaults userId to null', async () => {
    const res = await api('/api/connectors/gmail/status');
    expect(res.json.status.userId).toBeNull();
  });

  test('POST /api/connectors/:id/disconnect drops the binding', async () => {
    const res = await api('/api/connectors/gmail/disconnect', 'POST');
    expect(res.json.result.connected).toBe(false);
  });

  test('POST /api/connectors/execute uppercases the method and forwards the payload', async () => {
    const res = await api('/api/connectors/execute', 'POST', {
      connectorId: 'gmail',
      endpoint: '/messages',
      method: 'post',
      payload: { q: 'hi' },
      userId: 'u-1',
    });
    expect(res.status).toBe(200);
    expect(callTo('executeConnectorAction')).toEqual(['gmail', '/messages', 'POST', { q: 'hi' }, 'u-1']);
  });

  test('POST /api/connectors/execute defaults endpoint to / and method to GET', async () => {
    await api('/api/connectors/execute', 'POST', { connectorId: 'gmail' });
    expect(callTo('executeConnectorAction', 1)).toEqual(['gmail', '/', 'GET', {}, undefined]);
  });

  test('POST /api/connectors/execute requires a connectorId', async () => {
    const res = await api('/api/connectors/execute', 'POST', { endpoint: '/x' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/connectorId is required/);
  });

  test('POST /api/connectors/tools forwards query + limit', async () => {
    const res = await api('/api/connectors/tools', 'POST', { query: 'send mail', limit: 3 });
    expect(res.status).toBe(200);
    expect(res.json.tools[0]).toMatchObject({ query: 'send mail', limit: 3 });
  });

  test('POST /api/connectors/tools requires a query', async () => {
    const res = await api('/api/connectors/tools', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('GET /api/connectors/tools/schemas lists definitions with query passthrough', async () => {
    const res = await api('/api/connectors/tools/schemas?q=gmail&limit=5&offset=10');
    expect(res.status).toBe(200);
    expect(res.json.tools[0].tool_id).toBe('curated-gmail.send_message');
    expect(res.json.total).toBe(1);
    expect(res.json.connection['curated-gmail']).toEqual({ connected: true, status: 'connected' });
    expect(deps.calls.some(c => c.fn === 'listToolSchemas' && (c.args[0] as any)?.q === 'gmail')).toBe(true);
  });

  test('GET /api/connectors/:id/tools returns that connector schemas', async () => {
    const res = await api('/api/connectors/curated-gmail/tools');
    expect(res.status).toBe(200);
    expect(res.json.connector).toBe('curated-gmail');
    expect(res.json.tools[0].name).toBe('send_message');
    expect(res.json.connection.connected).toBe(true);
  });

  test('POST /api/connectors/ingest-openapi forwards options and returns the summary', async () => {
    const res = await api('/api/connectors/ingest-openapi', 'POST', {
      connectorId: 'search-research-wikipedia',
      specUrl: 'https://example.test/openapi.json',
      replace: false,
      maxTools: 40,
    });
    expect(res.status).toBe(200);
    expect(res.json.ingested).toBe(12);
    expect(res.json.catalogMatch).toBe(true);
    const call = deps.calls.filter(c => c.fn === 'ingestConnectorOpenApi').pop()!;
    expect(call.args[0]).toMatchObject({ connectorId: 'search-research-wikipedia', specUrl: 'https://example.test/openapi.json', replace: false, maxTools: 40 });
  });

  test('POST /api/connectors/ingest-openapi requires connectorId and a spec source', async () => {
    const noId = await api('/api/connectors/ingest-openapi', 'POST', { spec: { openapi: '3.0.0', paths: {} } });
    expect(noId.status).toBe(500);
    const noSpec = await api('/api/connectors/ingest-openapi', 'POST', { connectorId: 'x' });
    expect(noSpec.status).toBe(500);
  });

  test('POST /api/connectors/:id/ensure-tools forwards force and returns the summary', async () => {
    const res = await api('/api/connectors/apisguru-stripe/ensure-tools', 'POST', { force: true });
    expect(res.status).toBe(200);
    expect(res.json.result.connectorId).toBe('apisguru-stripe');
    expect(res.json.result.source).toBe('spec');
    const call = deps.calls.filter(c => c.fn === 'ensureConnectorTools').pop()!;
    expect(call.args[0]).toBe('apisguru-stripe');
    expect(call.args[1]).toMatchObject({ force: true });
  });

  test('POST /api/connectors/:id/ensure-tools defaults force to unset', async () => {
    const res = await api('/api/connectors/apisguru-stripe/ensure-tools', 'POST', {});
    expect(res.status).toBe(200);
    const call = deps.calls.filter(c => c.fn === 'ensureConnectorTools').pop()!;
    expect(call.args[1]).toMatchObject({});
  });

  test('POST /api/connectors/sync refreshes the catalog', async () => {
    const res = await api('/api/connectors/sync', 'POST');
    expect(res.json.result.synced).toBe(40);
  });

  test('POST /api/connectors/credential accepts snake_case aliases', async () => {
    const res = await api('/api/connectors/credential', 'POST', {
      slug: 'gmail',
      client_id: 'cid',
      client_secret: 'csec',
      scopes: ['gmail.readonly'],
    });
    expect(res.status).toBe(200);
    expect(callTo('saveConnectorCredential')).toEqual(['gmail', 'cid', 'csec', ['gmail.readonly']]);
  });

  test('POST /api/connectors/credential requires a slug', async () => {
    const res = await api('/api/connectors/credential', 'POST', {});
    expect(res.status).toBe(500);
  });
});

// ── Social ─────────────────────────────────────────────────────────

describe('social automation', () => {
  test('POST /api/social/post forwards the canonical snake_case fields', async () => {
    const res = await api('/api/social/post', 'POST', {
      platform: 'x',
      action: 'post',
      email: 'a@b.c',
      password: 'pw',
      text: 'hello',
      media_files: ['a.png'],
      max_comments: 5,
    });
    expect(res.status).toBe(200);
    expect(res.json.result).toMatchObject({ ok: true, platform: 'x', action: 'post', text: 'hello' });
    expect(callTo('socialPost')[0]).toMatchObject({ media_files: ['a.png'], max_comments: 5 });
  });

  test('POST /api/social/post requires a platform', async () => {
    const res = await api('/api/social/post', 'POST', { email: 'a@b.c', password: 'pw' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/platform is required/);
  });

  test('POST /api/social/post requires credentials', async () => {
    const res = await api('/api/social/post', 'POST', { platform: 'x' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/email and password are required/);
  });

  test('POST /api/social/schedule requires a unix-ms timestamp', async () => {
    const res = await api('/api/social/schedule', 'POST', { platform: 'x', email: 'a@b.c', password: 'pw' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/scheduledAt is required/);
  });

  test('POST /api/social/schedule books a post', async () => {
    const res = await api('/api/social/schedule', 'POST', {
      platform: 'x', email: 'a@b.c', password: 'pw', scheduledAt: 1700000000000,
    });
    expect(res.json.scheduled.scheduledAt).toBe(1700000000000);
  });

  test('GET /api/social/schedule lists queued posts', async () => {
    expect((await api('/api/social/schedule')).json.scheduled[0].id).toBe('sched-1');
  });

  test('POST /api/social/cancel requires an id', async () => {
    expect((await api('/api/social/cancel', 'POST', {})).status).toBe(500);
    expect((await api('/api/social/cancel', 'POST', { id: 'sched-1' })).json.cancelled.cancelled).toBe(true);
  });

  test('GET /api/social/status reports the automation state', async () => {
    expect((await api('/api/social/status')).json.social.configured).toBe(false);
  });
});

// ── Smart home ─────────────────────────────────────────────────────

describe('smart home', () => {
  test('GET /api/smart/status reports configuration', async () => {
    expect((await api('/api/smart/status')).json.configured).toBe(false);
  });

  test('POST /api/smart/token stores a masked PAT', async () => {
    const res = await api('/api/smart/token', 'POST', { token: 'pat-abcdef' });
    expect(res.status).toBe(200);
    expect(res.json.token).toBe('••••cdef');
    expect(res.json.token).not.toContain('pat-abcdef');
  });

  test('POST /api/smart/token requires a token', async () => {
    const res = await api('/api/smart/token', 'POST', { token: '  ' });
    expect(res.status).toBe(500);
  });

  test('DELETE /api/smart/token clears the PAT', async () => {
    const res = await api('/api/smart/token', 'DELETE');
    expect(res.status).toBe(200);
    expect(res.json.configured).toBe(false);
  });

  test('GET /api/smart/devices lists switches', async () => {
    expect((await api('/api/smart/devices')).json.devices[0].id).toBe('sw-1');
  });

  test('POST /api/smart/command accepts on|off', async () => {
    const res = await api('/api/smart/command', 'POST', { deviceId: 'sw-1', command: 'on' });
    expect(res.json.result).toEqual({ deviceId: 'sw-1', command: 'on', status: 'ok' });
  });

  test('POST /api/smart/command rejects an unknown verb', async () => {
    const res = await api('/api/smart/command', 'POST', { deviceId: 'sw-1', command: 'toggle' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/command \(on\|off\)/);
  });

  test('POST /api/smart/control resolves a device by name', async () => {
    const res = await api('/api/smart/control', 'POST', { name: 'Lamp', command: 'off' });
    expect(res.json.result.name).toBe('Lamp');
  });

  test('POST /api/smart/platforms/:key/oauth/start returns the consent URL', async () => {
    const res = await api('/api/smart/platforms/smartthings/oauth/start', 'POST', {});
    expect(res.json.platform).toBe('smartthings');
    expect(res.json.authorizeUrl).toContain('state=st-smartthings');
    expect(res.json.state).toBe('st-smartthings');
  });

  test('POST /api/smart/platforms/:key/oauth/start forwards an explicit redirect', async () => {
    await api('/api/smart/platforms/smartthings/oauth/start', 'POST', {
      redirectUri: 'http://127.0.0.1:9999/cb',
    });
    // deps.calls is shared across the file — take the most recent.
    const matches = deps.calls.filter(c => c.fn === 'smartOauthStart');
    expect(matches.pop()!.args).toEqual(['smartthings', 'http://127.0.0.1:9999/cb']);
  });

  test('GET /api/smart/platforms/:key/oauth/callback exchanges the code', async () => {
    const res = await api('/api/smart/platforms/smartthings/oauth/callback?code=abc123&state=st-smartthings');
    expect(res.json).toMatchObject({ ok: true, platform: 'smartthings', deviceCount: 3 });
    expect(callTo('smartOauthCallback')).toEqual(['smartthings', 'abc123', 'st-smartthings']);
  });

  test('GET /api/smart/platforms/:key/oauth/callback rejects a callback with no code or state', async () => {
    const before = deps.calls.filter(c => c.fn === 'smartOauthCallback').length;
    const res = await api('/api/smart/platforms/smartthings/oauth/callback?error=access_denied');
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/missing code or state/);
    expect(deps.calls.filter(c => c.fn === 'smartOauthCallback')).toHaveLength(before);
  });

  test('GET /api/smart/schedules lists schedules', async () => {
    expect((await api('/api/smart/schedules')).json.schedules[0].id).toBe('sch-1');
  });

  test('POST /api/smart/schedules accepts an interval rule', async () => {
    const res = await api('/api/smart/schedules', 'POST', {
      deviceId: 'sw-1', command: 'on', kind: 'everyMinutes', everyMinutes: 30,
    });
    expect(res.status).toBe(200);
    expect(res.json.schedule).toMatchObject({ kind: 'everyMinutes', everyMinutes: 30 });
  });

  test('POST /api/smart/schedules accepts a daily HH:MM rule', async () => {
    const res = await api('/api/smart/schedules', 'POST', {
      deviceId: 'sw-1', command: 'off', kind: 'at', at: '07:30',
    });
    expect(res.json.schedule).toMatchObject({ kind: 'at', at: '07:30' });
  });

  test('POST /api/smart/schedules requires everyMinutes for an interval rule', async () => {
    const res = await api('/api/smart/schedules', 'POST', { deviceId: 'sw-1', command: 'on', kind: 'everyMinutes' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/everyMinutes is required/);
  });

  test('POST /api/smart/schedules rejects a malformed HH:MM', async () => {
    const res = await api('/api/smart/schedules', 'POST', { deviceId: 'sw-1', command: 'on', kind: 'at', at: '7am' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/HH:MM/);
  });

  test('POST /api/smart/schedules/cancel requires an id', async () => {
    expect((await api('/api/smart/schedules/cancel', 'POST', {})).status).toBe(500);
    expect((await api('/api/smart/schedules/cancel', 'POST', { id: 'sch-1' })).json.cancelled.cancelled).toBe(true);
  });
});

// ── Vault ──────────────────────────────────────────────────────────

describe('vault', () => {
  test('GET /api/vault/entries never returns a raw secret', async () => {
    const res = await api('/api/vault/entries');
    expect(res.status).toBe(200);
    expect(res.json.entries[0].hasSecret).toBe(true);
    expect(res.json.entries[0]).not.toHaveProperty('secret');
  });

  test('POST /api/vault/entry stores a credential', async () => {
    const res = await api('/api/vault/entry', 'POST', { service: 'github', username: 'alex', secret: 'ghp_xxx' });
    expect(res.status).toBe(200);
    expect(res.json.entry.service).toBe('github');
    expect(callTo('setVaultEntry')[0]).toEqual({ service: 'github', username: 'alex', secret: 'ghp_xxx', id: undefined });
  });

  test('POST /api/vault/entry passes an explicit id through for updates', async () => {
    await api('/api/vault/entry', 'POST', { id: 'v1', service: 'github', secret: 'new' });
    expect((callTo('setVaultEntry', 1)[0] as any).id).toBe('v1');
  });

  test('DELETE /api/vault/entry/:id removes the entry', async () => {
    const res = await api('/api/vault/entry/v1', 'DELETE');
    expect(res.status).toBe(200);
    expect(res.json.deleted.id).toBe('v1');
  });
});

// ── Carousel ───────────────────────────────────────────────────────

describe('carousel', () => {
  test('POST /api/carrusel/create requires a name', async () => {
    const res = await api('/api/carrusel/create', 'POST', { aspectRatio: '1:1' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/name is required/);
  });

  test('POST /api/carrusel/create forwards the aspect ratio', async () => {
    const res = await api('/api/carrusel/create', 'POST', { name: 'Launch', aspectRatio: '4:5' });
    expect(res.json.carousel).toEqual({ id: 'car-1', name: 'Launch', aspectRatio: '4:5' });
  });

  test('GET /api/carrusel/list is matched before the :id pattern', async () => {
    const res = await api('/api/carrusel/list');
    expect(res.json.carousels[0].id).toBe('car-1');
  });

  test('GET /api/carrusel/brand is matched before the :id pattern', async () => {
    const res = await api('/api/carrusel/brand');
    expect(res.json.brand.font).toBe('Inter');
  });

  test('GET /api/carrusel/:id returns one carousel', async () => {
    const res = await api('/api/carrusel/car-1');
    expect(res.json.carousel.slides).toBe(3);
  });

  test('POST /api/carrusel/:id/slides requires slide HTML', async () => {
    const res = await api('/api/carrusel/car-1/slides', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/html is required/);
  });

  test('POST /api/carrusel/:id/slides appends a slide', async () => {
    const res = await api('/api/carrusel/car-1/slides', 'POST', { html: '<h1>Hi</h1>', note: 'cover' });
    expect(res.json.slide).toEqual({ carouselId: 'car-1', slide: 4, note: 'cover' });
  });

  test('POST /api/carrusel/chat requires a message', async () => {
    expect((await api('/api/carrusel/chat', 'POST', {})).status).toBe(500);
  });

  test('POST /api/carrusel/chat scopes the reply to a carousel', async () => {
    const res = await api('/api/carrusel/chat', 'POST', { message: 'warmer', carouselId: 'car-1' });
    expect(res.json.response.carouselId).toBe('car-1');
  });

  test('POST /api/carrusel/:id/export returns a zip payload', async () => {
    const res = await api('/api/carrusel/car-1/export', 'POST');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ zipBase64: 'UEsDBA==', carouselId: 'car-1' });
  });

  test('POST /api/carrusel/:id/duplicate forks the carousel', async () => {
    expect((await api('/api/carrusel/car-1/duplicate', 'POST')).json.carousel.id).toBe('car-1-copy');
  });

  test('DELETE /api/carrusel/:id removes it', async () => {
    expect((await api('/api/carrusel/car-1', 'DELETE')).json.deleted.deleted).toBe(true);
  });

  test('the start/stop/status triple responds', async () => {
    expect((await api('/api/carrusel/start', 'POST')).json.status.running).toBe(true);
    expect((await api('/api/carrusel/status')).json.status.installed).toBe(true);
    expect((await api('/api/carrusel/stop', 'POST')).json.status.running).toBe(false);
  });
});

// ── Twenty CRM ─────────────────────────────────────────────────────

describe('twenty CRM', () => {
  test('GET /api/twenty/status reports the SQLite fallback', async () => {
    const res = await api('/api/twenty/status');
    expect(res.json.status.fallback).toBe('local SQLite-backed CRM');
  });

  test('the start/stop pair responds', async () => {
    expect((await api('/api/twenty/start', 'POST')).json.status.running).toBe(true);
    expect((await api('/api/twenty/stop', 'POST')).json.status.running).toBe(false);
  });

  test('POST /api/twenty/graphql forwards the query and variables', async () => {
    const res = await api('/api/twenty/graphql', 'POST', {
      query: '{ people { edges { node { name } } } }',
      variables: { first: 10 },
    });
    expect(res.status).toBe(200);
    expect(res.json.result.data.people.totalCount).toBe(1);
    expect(callTo('twentyGraphql')[0]).toEqual({
      query: '{ people { edges { node { name } } } }',
      variables: { first: 10 },
    });
  });

  test('POST /api/twenty/graphql requires a query', async () => {
    const res = await api('/api/twenty/graphql', 'POST', { variables: {} });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/query is required/);
  });
});

// ── Mesh + devices ─────────────────────────────────────────────────

describe('mesh and devices', () => {
  test('POST /api/mesh/pair defaults the ttl to 120s', async () => {
    const res = await api('/api/mesh/pair', 'POST', {});
    expect(res.status).toBe(200);
    expect(res.json.pair.exp).toBe(1000 + 120 * 1000);
  });

  test('POST /api/mesh/pair-demo runs the local match', async () => {
    const res = await api('/api/mesh/pair-demo', 'POST');
    expect(res.json.pair.match).toBe(true);
  });

  test('GET /api/devices lists paired devices', async () => {
    expect((await api('/api/devices')).json.devices[0].id).toBe('dev-1');
  });

  test('POST /api/devices/invite defaults to an unnamed invite', async () => {
    const res = await api('/api/devices/invite', 'POST', {});
    expect(res.json.invite).toEqual({ code: 'INVITE-1', name: '' });
  });

  test('POST /api/devices/invite carries the device name', async () => {
    const res = await api('/api/devices/invite', 'POST', { name: 'Pixel' });
    expect(res.json.invite.name).toBe('Pixel');
  });

  test('POST /api/devices/join forwards role and capabilities', async () => {
    const res = await api('/api/devices/join', 'POST', {
      code: 'INVITE-1', name: 'Pixel', role: 'phone', capabilities: ['voice'],
    });
    expect(res.json.join).toEqual({ code: 'INVITE-1', name: 'Pixel', role: 'phone', capabilities: ['voice'], joined: true });
  });

  test('POST /api/devices/join defaults the name to "Device"', async () => {
    const res = await api('/api/devices/join', 'POST', { code: 'INVITE-1' });
    expect(res.json.join.name).toBe('Device');
  });

  test('POST /api/devices/join requires a code', async () => {
    expect((await api('/api/devices/join', 'POST', {})).status).toBe(500);
  });

  test('POST /api/devices/revoke requires a deviceId', async () => {
    expect((await api('/api/devices/revoke', 'POST', {})).status).toBe(500);
    expect((await api('/api/devices/revoke', 'POST', { deviceId: 'dev-1' })).json.revoked.revoked).toBe(true);
  });

  test('POST /api/devices/send forwards the message envelope', async () => {
    const res = await api('/api/devices/send', 'POST', { deviceId: 'dev-1', msg: { kind: 'ping' } });
    expect(res.json.sent).toEqual({ deviceId: 'dev-1', sent: true, kind: 'ping' });
  });

  test('POST /api/devices/send defaults msg to an empty object', async () => {
    const res = await api('/api/devices/send', 'POST', { deviceId: 'dev-1' });
    expect(res.json.sent.kind).toBeNull();
  });
});

// ── Auth signup / login ────────────────────────────────────────────

describe('auth signup and login', () => {
  test('POST /api/auth/signup requires all three fields', async () => {
    const res = await api('/api/auth/signup', 'POST', { email: 'a@b.c' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/email, password, and name are required/);
  });

  test('POST /api/auth/signup returns the new user', async () => {
    const res = await api('/api/auth/signup', 'POST', { email: 'a@b.c', password: 'pw', name: 'Alex' });
    expect(res.status).toBe(200);
    expect(res.json.user).toMatchObject({ email: 'a@b.c', name: 'Alex', token: 'tok-signup' });
  });

  test('POST /api/auth/signup never echoes the password back', async () => {
    const res = await api('/api/auth/signup', 'POST', { email: 'a@b.c', password: 'hunter2', name: 'Alex' });
    expect(JSON.stringify(res.json)).not.toContain('hunter2');
  });

  test('POST /api/auth/login requires email + password', async () => {
    const res = await api('/api/auth/login', 'POST', { email: 'a@b.c' });
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/email and password are required/);
  });

  test('POST /api/auth/login returns a session token', async () => {
    const res = await api('/api/auth/login', 'POST', { email: 'a@b.c', password: 'pw' });
    expect(res.json.user.token).toBe('tok-login');
  });
});

// ── Task-scope ID guards (403, no dep call) ─────────────────────────

describe('task-scope guards', () => {
  test('POST /api/worker/claim rejects slashed ids with 403', async () => {
    const before = deps.calls.length;
    const res = await api('/api/worker/claim', 'POST', { taskId: 'a/b', workerId: 'w' });
    expect(res.status).toBe(403);
    expect(deps.calls.length).toBe(before);
  });

  test('POST /api/actions/review rejects spaced ids with 403', async () => {
    const before = deps.calls.length;
    const res = await api('/api/actions/review', 'POST', { proposalId: 'a b', approved: true, hash: 'h' });
    expect(res.status).toBe(403);
    expect(deps.calls.length).toBe(before);
  });

  test('POST /api/input/:id/answer rejects traversal taskIds with 403', async () => {
    const before = deps.calls.length;
    const res = await api('/api/input/in-1/answer', 'POST', { taskId: '../x', answer: 'yes' });
    expect(res.status).toBe(403);
    expect(deps.calls.length).toBe(before);
  });
});
