/**
 * VibeVoiceTts — bridge to Microsoft's VibeVoice local voice AI
 * (https://github.com/microsoft/VibeVoice), cloned into external/VibeVoice.
 *
 * Drives the VibeVoice-Realtime-0.5B streaming TTS model by calling the
 * repo's `demo/realtime_model_inference_from_file.py` with a speaker prompt.
 * The repo ships multilingual speaker presets (en/de/fr/it/jp/kr/nl/pl/pt/sp),
 * so Umbra can speak different voices in different languages.
 *
 * Voice *cloning* is intentionally not exposed here: Microsoft removed the
 * VibeVoice-TTS (voice-cloning) code from the repo in Sept 2025, so only the
 * pre-embedded speaker prompts are available.
 *
 * The model weights are downloaded from Hugging Face on first use
 * (microsoft/VibeVoice-Realtime-0.5B) — inference needs a Python 3.10+ env
 * installed via scripts/vibevoice-install.sh (GPU recommended).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getLogger } from '../Logger';

export interface VibeVoiceVoice {
  /** Full prompt id, e.g. "en-Carter_man". */
  id: string;
  /** Speaker name, e.g. "Carter". */
  name: string;
  /** Language code, e.g. "en" / "de" / "fr". */
  language: string;
  gender: 'man' | 'woman' | 'unknown';
  file: string;
}

export interface VibeVoiceSpeakOptions {
  /** Speaker name or id (e.g. "Carter" or "en-Carter_man"). */
  voice?: string;
  /** Language code to pick a speaker by (e.g. "de"). */
  language?: string;
  /** Inference device override. */
  device?: 'cuda' | 'mps' | 'cpu';
  /** Model id / local path override. */
  model?: string;
}

export interface VibeVoiceResult {
  path: string;
  wav: Buffer;
  voice: string;
  language: string;
}

export interface VibeVoiceOptions {
  /** Path to the cloned VibeVoice repo (external/VibeVoice). */
  repoDir: string;
  /** Explicit python interpreter (e.g. the repo's .venv python). */
  python?: string;
  /** Model id/path (default microsoft/VibeVoice-Realtime-0.5B). */
  model?: string;
  /** Default inference device (auto-detect by default). */
  device?: 'auto' | 'cuda' | 'mps' | 'cpu';
  /** Where to write temp text + generated wavs. */
  outputDir?: string;
  /** Injectable runner for tests. */
  run?: (cmd: string, args: string[]) => void;
}

const VOICE_RE = /^([a-z]{2,3})-([a-z0-9]+)_(man|woman)\.pt$/i;

export function parseVoiceFile(filename: string): VibeVoiceVoice | null {
  const m = VOICE_RE.exec(filename);
  if (!m) return null;
  return {
    id: filename.replace(/\.pt$/i, ''),
    name: m[2],
    language: m[1].toLowerCase(),
    gender: m[3].toLowerCase() as 'man' | 'woman',
    file: filename,
  };
}

export class VibeVoiceTts {
  private repoDir: string;
  private python?: string;
  private model: string;
  private device: 'auto' | 'cuda' | 'mps' | 'cpu';
  private outputDir?: string;
  private runFn?: (cmd: string, args: string[]) => void;

  constructor(options: VibeVoiceOptions) {
    this.repoDir = options.repoDir;
    this.python = options.python;
    this.model = options.model ?? 'microsoft/VibeVoice-Realtime-0.5B';
    this.device = options.device ?? 'auto';
    this.outputDir = options.outputDir;
    this.runFn = options.run;
  }

  get voicesDir(): string {
    return path.join(this.repoDir, 'demo', 'voices', 'streaming_model');
  }

  /** Whether the repo + package are present (not whether the env is built). */
  get installed(): boolean {
    return fs.existsSync(path.join(this.repoDir, 'vibevoice', 'modular', 'modeling_vibevoice_streaming_inference.py'));
  }

  /** Speaker prompts shipped in the repo, parsed into language/name/gender. */
  listVoices(): VibeVoiceVoice[] {
    try {
      return fs.readdirSync(this.voicesDir)
        .filter(f => f.endsWith('.pt'))
        .map(parseVoiceFile)
        .filter((v): v is VibeVoiceVoice => v !== null)
        .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** Pick a speaker from a name/id and/or a language code. */
  resolveVoice(voice?: string, language?: string): VibeVoiceVoice | null {
    const voices = this.listVoices();
    if (voices.length === 0) return null;

    if (voice) {
      const v = voice.trim().toLowerCase();
      const exact = voices.find(x => x.id.toLowerCase() === v || x.name.toLowerCase() === v);
      if (exact) return exact;
      const partial = voices.find(x => x.name.toLowerCase().includes(v) || v.includes(x.name.toLowerCase()));
      if (partial) return partial;
    }
    if (language) {
      const l = language.trim().toLowerCase();
      const match = voices.find(x => x.language === l);
      if (match) return match;
    }
    return voices.find(x => x.name.toLowerCase() === 'carter') || voices[0];
  }

  async speak(text: string, opts: VibeVoiceSpeakOptions = {}): Promise<VibeVoiceResult> {
    const t = text.trim();
    if (!t) throw new Error('VibeVoice: empty text');
    if (!this.installed) {
      throw new Error('VibeVoice repo not found — run `git clone https://github.com/microsoft/VibeVoice.git external/VibeVoice`');
    }

    const voice = this.resolveVoice(opts.voice, opts.language);
    if (!voice) throw new Error('VibeVoice: no speaker voices found');

    const outputDir = this.outputDir || path.join(this.repoDir, 'outputs');
    fs.mkdirSync(outputDir, { recursive: true });
    const base = `umbra-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const txtPath = path.join(outputDir, `${base}.txt`);
    fs.writeFileSync(txtPath, t, 'utf-8');

    const python = this.resolvePython();
    const script = path.join(this.repoDir, 'demo', 'realtime_model_inference_from_file.py');
    const args = [
      script,
      '--model_path', opts.model ?? this.model,
      '--txt_path', txtPath,
      '--speaker_name', voice.id,
      '--output_dir', outputDir,
    ];
    const device = opts.device ?? (this.device === 'auto' ? undefined : this.device);
    if (device) args.push('--device', device);

    getLogger().info({ voice: voice.id, language: voice.language, device: device ?? 'auto' }, 'VibeVoice synthesizing speech');
    const run = this.runFn ?? ((cmd: string, a: string[]) => execFileSync(cmd, a, {
      stdio: 'pipe',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    }));
    run(python, args);

    const candidates = [
      path.join(outputDir, `${base}_generated.wav`),
      path.join(outputDir, `${base}.wav`),
      path.join(outputDir, `${base}_output.wav`),
    ];
    let wavPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { wavPath = c; break; }
    }
    if (!wavPath) {
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith(base) && f.endsWith('.wav')).sort();
      if (files.length > 0) wavPath = path.join(outputDir, files[0]);
    }
    if (!wavPath || !fs.existsSync(wavPath)) {
      throw new Error('VibeVoice produced no audio output');
    }
    const wav = fs.readFileSync(wavPath);
    try { fs.unlinkSync(txtPath); } catch { }
    return { path: wavPath, wav, voice: voice.id, language: voice.language };
  }

  private resolvePython(): string {
    if (this.python && fs.existsSync(this.python)) return this.python;
    const venv = path.join(this.repoDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
    if (fs.existsSync(venv)) return venv;
    return this.python || (process.platform === 'win32' ? 'python' : 'python3');
  }
}
