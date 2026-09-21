import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VibeVoiceTts, parseVoiceFile } from './VibeVoiceTts';

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibevoice-test-'));
  fs.mkdirSync(path.join(dir, 'vibevoice', 'modular'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vibevoice', 'modular', 'modeling_vibevoice_streaming_inference.py'), '# stub');
  const voices = path.join(dir, 'demo', 'voices', 'streaming_model');
  fs.mkdirSync(voices, { recursive: true });
  for (const f of ['en-Carter_man.pt', 'en-Emma_woman.pt', 'de-Spk0_man.pt', 'fr-Spk1_woman.pt', 'sp-Spk0_woman.pt']) {
    fs.writeFileSync(path.join(voices, f), 'fake');
  }
  return dir;
}

describe('parseVoiceFile', () => {
  it('parses language, name and gender from a prompt filename', () => {
    expect(parseVoiceFile('en-Carter_man.pt')).toMatchObject({ id: 'en-Carter_man', name: 'Carter', language: 'en', gender: 'man' });
    expect(parseVoiceFile('de-Spk0_man.pt')).toMatchObject({ language: 'de', gender: 'man' });
    expect(parseVoiceFile('weird.pt')).toBeNull();
  });
});

describe('VibeVoiceTts', () => {
  it('lists and resolves voices by name, language, then default', () => {
    const tts = new VibeVoiceTts({ repoDir: makeRepo() });
    const voices = tts.listVoices();
    expect(voices.length).toBe(5);
    expect(tts.resolveVoice('Emma')?.id).toBe('en-Emma_woman');
    expect(tts.resolveVoice(undefined, 'de')?.id).toBe('de-Spk0_man');
    expect(tts.resolveVoice('nope', 'xx')?.name).toBe('Carter');
  });

  it('speaks text by running the inference script and reading the wav', async () => {
    const dir = makeRepo();
    const out = path.join(dir, 'outputs');
    let seenArgs: string[] = [];
    const tts = new VibeVoiceTts({
      repoDir: dir,
      outputDir: out,
      python: 'python',
      run: (cmd, args) => {
        seenArgs = args;
        // The script writes <txtbase>_generated.wav; simulate it.
        const txt = args[args.indexOf('--txt_path') + 1];
        const base = path.basename(txt, '.txt');
        fs.writeFileSync(path.join(out, `${base}_generated.wav`), Buffer.from('WAV'));
      },
    });

    const res = await tts.speak('hello world', { voice: 'Emma' });
    expect(res.voice).toBe('en-Emma_woman');
    expect(res.wav.toString()).toBe('WAV');
    expect(seenArgs).toContain('--speaker_name');
    expect(seenArgs[seenArgs.indexOf('--speaker_name') + 1]).toBe('en-Emma_woman');
  });

  it('reports not-installed when the package is missing', () => {
    const tts = new VibeVoiceTts({ repoDir: path.join(os.tmpdir(), 'does-not-exist-vv') });
    expect(tts.installed).toBe(false);
  });
});
