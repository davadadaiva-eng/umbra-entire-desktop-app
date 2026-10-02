#!/usr/bin/env node
/**
 * meeting-companion-driver.js — verifies the ORGANIC meeting loopback path
 * (chunker → WASAPI loopback capture → STT → transcript) with the real
 * production MeetingCompanion class, wired exactly like index.ts does, minus
 * only the browser join (RealDesktop2.openChrome CDP attach wedges this
 * machine's backend under automation; the HTTP/browser layer is verified
 * separately — the session itself is created before any CDP dispatch).
 *
 *   join() (no onJoin) → startListening() → chunker records chunkSec windows
 *   of the system mix → piper speaks via the production onSpeak path →
 *   the chunker must pick the spoken audio out of the mix and transcribe it
 *   into the transcript, on its own.
 *
 * Usage: node scripts/meeting-companion-driver.js   (Windows + local voice servers)
 */
'use strict';
const path = require('path');
const os = require('os');

const BACKEND = path.resolve(__dirname, '..');
const { MeetingCompanion } = require(path.join(BACKEND, 'dist', 'core', 'meeting', 'MeetingCompanion'));
const { LoopbackRecorder } = require(path.join(BACKEND, 'dist', 'core', 'audio', 'LoopbackRecorder'));
const { SpeechToText } = require(path.join(BACKEND, 'dist', 'core', 'voice', 'SpeechToText'));
const { PiperTts } = require(path.join(BACKEND, 'dist', 'core', 'voice', 'PiperTts'));
const { AudioRouter } = require(path.join(BACKEND, 'dist', 'core', 'audio', 'AudioRouter'));

const SPOKEN = 'Prova di registrazione microfonica del compagno di riunione.';
let failures = 0;

function ok(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32m\u2714' : '\x1b[31m\u2716'} ${name}${detail ? ` \u2014 ${detail}` : ''}\x1b[0m`);
  if (!cond) failures++;
}

async function main() {
  console.log('\nUmbra meeting companion — organic loopback driver (production classes, no browser join)\n');
  const config = require(path.join(os.homedir(), '.umbra', 'config.json'));
  const chunkSec = (config.meeting && config.meeting.chunkSec) || 6;

  const stt = new SpeechToText(config);
  const recorder = new LoopbackRecorder({ dataDir: path.join(os.homedir(), '.umbra') });
  const piper = new PiperTts({
    baseUrl: config.voice.piperUrl,
    defaultVoice: config.voice.piperVoice,
    defaultLanguage: config.voice.piperLanguage,
    outputDir: path.join(os.homedir(), '.umbra', 'tts'),
  });
  const audio = new AudioRouter({ dataDir: path.join(os.homedir(), '.umbra') });

  const companion = new MeetingCompanion({
    stt: {
      transcribe: async (buf, format) => {
        const r = await stt.transcribe({ audio: buf, format, language: 'it' });
        if (!r.ok) console.log(`  [stt degraded] ${r.error || ''}`);
        return { text: r.text };
      },
    },
    recorder,
    onSpeak: async (text) => {
      const wav = await piper.speak(text, { voice: config.voice.piperVoice });
      await audio.play(wav);
      return 'Spoke via piper TTS';
    },
    chunkSec,
    ordersEnabled: false,
  });

  const session = await companion.join('https://meet.jit.si/umbra-loopback-test');
  ok('session created (no browser join)', !!session && !!session.id, session.id);

  companion.startListening();
  ok('listening started (chunker armed)', companion.status().status === 'listening');

  process.stdout.write(`  speaking via piper while the ${chunkSec}s chunker records the system mix…\n`);
  // Whisper hears the sentence through the room/mix at chunk boundaries, so
  // match fuzzily: a segment counts when enough key tokens of the spoken
  // sentence show up (exact text matching is not a realistic bar for a
  // live system-mix capture).
  const KEY_TOKENS = ['prova', 'registraz', 'microf', 'compagn', 'riunion'];
  const score = t => KEY_TOKENS.filter(k => t.includes(k)).length;
  let heard = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !heard) {
    await companion.speak(SPOKEN).catch(e => console.log(`  [speak] ${e.message}`));
    await new Promise(r => setTimeout(r, 4000));
    const segs = companion.status().transcript;
    heard = segs.filter(s => score(s.text.toLowerCase()) >= 2)
      .sort((a, b) => score(b.text.toLowerCase()) - score(a.text.toLowerCase()))[0] || null;
  }
  ok('organic loopback: chunker captured + transcribed the spoken audio', !!heard,
    heard ? `"${heard.text.slice(0, 90)}"`
          : `transcript: ${companion.status().transcript.map(s => s.text).join(' | ').slice(0, 140) || '(empty)'}`);

  await companion.leave();
  const after = companion.status();
  ok('meeting left', !after || after.status !== 'listening', after ? `status=${after.status}` : 'session cleared');

  console.log('');
  if (failures) { console.log(`\x1b[31m${failures} check(s) failed\x1b[0m`); process.exit(1); }
  console.log('\x1b[32mMeeting companion organic loopback verified\x1b[0m');
}

main().catch(e => { console.error('driver failed:', e.message); process.exit(1); });
