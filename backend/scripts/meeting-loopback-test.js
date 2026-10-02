#!/usr/bin/env node
/**
 * meeting-loopback-test.js — E2E check for the meeting companion voice loop:
 *
 *   1. POST /api/meeting/join   — join a test meeting (desktop: opens it in
 *                                 the agent Chrome on Desktop 2)
 *   2. POST /api/meeting/listen — with meeting.loopbackEnabled=true this arms
 *                                 the WASAPI loopback recorder (chunkSec)
 *   3. POST /api/meeting/speak  — speak an Italian sentence via meeting.tts
 *                                 (piper → default render device = speakers)
 *   4. The loopback path must pick the spoken audio up out of the system
 *      mix and transcribe it — checked organically in GET /api/meeting/status
 *      (best-effort: depends on WASAPI loopback + which render device is
 *      default), while the explicit POST /api/meeting/audio (feedAudio) path
 *      must transcribe deterministically.
 *   5. POST /api/meeting/leave  — session left, mic restored
 *
 * Also verifies the `piper` meeting.tts branch (speakForMeeting/synthesizeWav)
 * that previously threw "Meeting TTS is disabled" for tts='piper'.
 *
 * Usage: node scripts/meeting-loopback-test.js [baseUrl]   (default :8787)
 * Needs: faster-whisper STT (17510) + piper TTS (17520) + desktop-mode backend.
 */
'use strict';
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TTS = 'http://127.0.0.1:17520';
const SPOKEN = 'Prova di registrazione microfonica del compagno di riunione.';
let failures = 0;

function ok(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32m\u2714' : '\x1b[31m\u2716'} ${name}${detail ? ` \u2014 ${detail}` : ''}\x1b[0m`);
  if (!cond) failures++;
}

async function api(path, method = 'GET', body, timeoutMs = 45000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`\nUmbra meeting loopback E2E \u2014 ${BASE}\n`);

  // 0. Preconditions
  const ttsHealth = await fetch(`${TTS}/health`).then(r => r.json()).catch(() => null);
  ok('piper TTS server ready', !!ttsHealth && ttsHealth.state === 'ready', ttsHealth && `${ttsHealth.voice}`);

  // 1. Join a test meeting (clear any stale session first; on desktop the
  // join opens the URL in the agent Chrome — a CDP failure can still leave a
  // valid session behind, so accept that too).
  await api('/api/meeting/leave', 'POST', undefined, 10000).catch(() => {});
  const join = await api('/api/meeting/join', 'POST', { url: 'https://meet.jit.si/umbra-loopback-test' }, 90000);
  const st0 = await api('/api/meeting/status', 'GET', undefined, 10000);
  ok('meeting join accepted', join.status === 200 || (!!st0.json.meeting && !!st0.json.meeting.id),
    JSON.stringify(join.json).slice(0, 140));
  ok('session exists after join', st0.status === 200 && !!st0.json.meeting && !!st0.json.meeting.id,
    st0.json.meeting ? `status=${st0.json.meeting.status}` : 'no session');

  // 2. Start listening (arms the loopback recorder in desktop mode)
  const listen = await api('/api/meeting/listen', 'POST');
  ok('listening started', listen.status === 200, JSON.stringify(listen.json).slice(0, 120));
  const st1 = await api('/api/meeting/status');
  ok('status flipped to listening', (st1.json.meeting || {}).status === 'listening',
    `status=${(st1.json.meeting || {}).status}`);

  // 3. Speak through the meeting TTS path (piper branch)
  const speak = await api('/api/meeting/speak', 'POST', { text: SPOKEN });
  ok('meeting speak works with meeting.tts=piper', speak.status === 200 &&
    /Spoke/i.test(String((speak.json || {}).result || '')), JSON.stringify(speak.json).slice(0, 160));

  // 4a. Explicit feedAudio path: same sentence as WAV → must transcribe
  const wav = Buffer.from(await fetch(`${TTS}/speak`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: SPOKEN }),
  }).then(r => r.arrayBuffer()));
  ok('synthesized WAV for feedAudio', wav.length > 1000, `${wav.length} bytes`);
  const fed = await api('/api/meeting/audio', 'POST', { audio: wav.toString('base64'), format: 'wav' });
  const fedText = String(((fed.json || {}).segment || {}).text || '');
  ok('feedAudio transcribed the spoken sentence', fed.status === 200 && fedText.length > 3,
    `text="${fedText.slice(0, 90)}"`);

  // 4b. Organic loopback: the chunker records chunkSec windows of the system
  // mix, and a silent window transcribes to empty text (skipped silently).
  // A one-shot utterance can fall entirely between windows, so keep speaking
  // while polling the transcript for the spoken sentence.
  const REPS = 6;
  process.stdout.write(`  speaking ${REPS}x while the loopback chunker records…\n`);
  const speaking = (async () => {
    for (let i = 0; i < REPS; i++) {
      await api('/api/meeting/speak', 'POST', { text: SPOKEN }, 60000).catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
    }
  })();
  let organic = false;
  let texts = [];
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const st2 = await api('/api/meeting/status', 'GET', undefined, 10000).catch(() => null);
    const transcript = (((st2 || {}).json || {}).meeting || {}).transcript || [];
    texts = transcript.map(s => String(s.text || '').toLowerCase());
    organic = texts.some(t => t.includes('prova') && t.includes('registrazion'));
    if (organic) break;
  }
  await speaking;
  ok('loopback captured + transcribed the spoken audio (organic)', organic,
    organic ? texts.filter(t => t.includes('prova')).join(' | ').slice(0, 90)
            : `transcript has ${texts.length} segment(s): ${texts.join(' | ').slice(0, 140)}`);

  // 5. Leave (restores the mic when routeMic was used)
  const leave = await api('/api/meeting/leave', 'POST', undefined, 30000);
  ok('meeting left', leave.status === 200, JSON.stringify(leave.json).slice(0, 100));
  const st3 = await api('/api/meeting/status', 'GET', undefined, 10000).catch(() => null);
  const after = ((st3 || {}).json || {}).meeting;
  ok('no listening session after leave', !after || after.status !== 'listening',
    after ? `status=${after.status}` : 'session cleared');

  console.log('');
  if (failures) { console.log(`\x1b[31m${failures} check(s) failed\x1b[0m`); process.exit(1); }
  console.log('\x1b[32mAll meeting loopback E2E checks passed\x1b[0m');
}

main().catch(e => { console.error('E2E run failed:', e.message); process.exit(1); });
