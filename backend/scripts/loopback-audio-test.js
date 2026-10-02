#!/usr/bin/env node
/**
 * loopback-audio-test.js — component-level E2E for the meeting loopback path,
 * using the SAME production classes the MeetingCompanion wires in index.ts:
 *
 *   PiperTts.speak() → AudioRouter.play(wav, default render)
 *        ↓ (sound comes out of the speakers)
 *   LoopbackRecorder.record(chunkSec)  ← WASAPI loopback captures the mix
 *        ↓
 *   FasterWhisperStt / SpeechToText.transcribe(wav)
 *        ↓
 *   transcript text must contain what was spoken
 *
 * This is exactly the meeting.tts='piper' + loopbackEnabled=true pipeline
 * (speakForMeeting → synthesizeWav → audioRouter.play; loopbackOnce →
 * recorder.record → stt.transcribe → companion.ingest) minus the HTTP layer,
 * so it isolates the audio path from unrelated backend boot instability.
 *
 * Usage: node scripts/loopback-audio-test.js   (Windows + local voice servers)
 */
'use strict';
const path = require('path');
const os = require('os');

const BACKEND = path.resolve(__dirname, '..');
const { PiperTts } = require(path.join(BACKEND, 'dist', 'core', 'voice', 'PiperTts'));
const { AudioRouter } = require(path.join(BACKEND, 'dist', 'core', 'audio', 'AudioRouter'));
const { LoopbackRecorder } = require(path.join(BACKEND, 'dist', 'core', 'audio', 'LoopbackRecorder'));
const { SpeechToText } = require(path.join(BACKEND, 'dist', 'core', 'voice', 'SpeechToText'));

const SPOKEN = 'Prova di registrazione microfonica del compagno di riunione.';
const CHUNK_SEC = 8;
let failures = 0;

function ok(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32m\u2714' : '\x1b[31m\u2716'} ${name}${detail ? ` \u2014 ${detail}` : ''}\x1b[0m`);
  if (!cond) failures++;
}

async function main() {
  console.log('\nUmbra meeting loopback audio E2E (production classes)\n');

  // Load the real user config, exactly like the composition root does.
  const config = require(path.join(os.homedir(), '.umbra', 'config.json'));

  const piper = new PiperTts({
    baseUrl: config.voice.piperUrl,
    defaultVoice: config.voice.piperVoice,
    defaultLanguage: config.voice.piperLanguage,
    outputDir: path.join(os.homedir(), '.umbra', 'tts'),
  });
  const audio = new AudioRouter({ dataDir: path.join(os.homedir(), '.umbra') });
  const recorder = new LoopbackRecorder({ dataDir: path.join(os.homedir(), '.umbra') });
  const stt = new SpeechToText(config);

  // 1. Piper healthy?
  const piperOk = await piper.isRunning();
  ok('Piper TTS ready', piperOk, config.voice.piperUrl);

  // 2. STT configured (faster-whisper)?
  ok('STT configured (faster-whisper)', stt.available && stt.provider === 'faster-whisper',
    `${stt.provider} → ${stt.endpoint}`);

  // 3. Loopback capture available?
  ok('WASAPI loopback available', recorder.available);

  // 4. Speak + capture + transcribe — the loopback path itself.
  process.stdout.write(`  speaking via piper: "${SPOKEN}"\n`);
  const wav = await piper.speak(SPOKEN, { voice: config.voice.piperVoice });
  ok('piper synthesized speech', wav.length > 5000, `${wav.length} bytes`);

  const devices = await audio.listDevices('render').catch(() => []);
  ok('render devices enumerated', devices.length > 0, devices.slice(0, 2).map(d => d.name).join(', '));

  // Speak and record the system mix concurrently — the meeting loop does this
  // continuously (speak while the loopback recorder chunks). The speaker keeps
  // playing for the whole capture window: the recorder's first run compiles
  // its interop (~5s), so a one-shot play could end before capture starts.
  process.stdout.write(`  recording the system mix for ${CHUNK_SEC}s while piper speaks…\n`);
  const speakLoop = (async () => {
    const deadline = Date.now() + (CHUNK_SEC + 2) * 1000;
    while (Date.now() < deadline) {
      await audio.play(wav).catch(() => {});
      await new Promise(r => setTimeout(r, 150));
    }
  })();
  const [chunk] = await Promise.all([
    recorder.record(CHUNK_SEC),
    speakLoop,
  ]);
  ok('loopback captured a chunk', chunk && chunk.length > 10000, `${chunk.length} bytes of WAV`);

  const r = await stt.transcribe({ audio: chunk, format: 'wav', language: 'it' });
  ok('STT transcribed the captured mix', r.ok, r.ok ? '' : `${r.error} (fix: ${r.hint})`);
  const text = (r.text || '').toLowerCase();
  const heard = text.includes('prova') && (text.includes('registrazion') || text.includes('microfonic'));
  ok('transcript contains the spoken sentence (loopback verified end-to-end)', heard,
    `heard: "${(r.text || '').slice(0, 100)}"`);

  console.log('');
  if (failures) { console.log(`\x1b[31m${failures} check(s) failed\x1b[0m`); process.exit(1); }
  console.log('\x1b[32mLoopback audio path verified: speak \u2192 speakers \u2192 WASAPI capture \u2192 STT transcript\x1b[0m');
}

main().catch(e => { console.error('E2E run failed:', e.message); process.exit(1); });
