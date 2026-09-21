import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { OpenMontageBridge, ToolRunResult } from './OpenMontageBridge';
import { VoiceboxTTS } from './VoiceboxTTS';
import { LLMConnector, LLMMessage } from '../agent/LLMConnector';
import { getLogger } from '../Logger';

export type VideoSceneType = 'title' | 'bullets' | 'quote' | 'text' | 'image';

export interface VideoScene {
  type: VideoSceneType;
  title?: string;
  lines?: string[];
  text?: string;
  imagePath?: string;
  seconds?: number;
}

export interface VideoScript {
  title: string;
  narration: string;
  scenes: VideoScene[];
}

export interface VideoBrief {
  description: string;
  title?: string;
  script?: VideoScript;
  voiceProfile?: string;
  style?: string;
  fps?: number;
  width?: number;
  height?: number;
}

export interface VideoResult {
  videoPath: string;
  narrationPath?: string;
  script: VideoScript;
  compositionEntry?: string;
}

const OPENMONTAGE_DIR = path.resolve(__dirname, '..', '..', '..', 'external', 'OpenMontage');
const COMPOSER_DIR = path.join(OPENMONTAGE_DIR, 'remotion-composer');
const COMPOSITION_ID = 'UmbraProduction';

const SCENE_MIN_SECONDS: Record<VideoSceneType, number> = {
  title: 2.5,
  bullets: 3,
  quote: 3,
  text: 3,
  image: 3,
};

export class VideoProducer {
  private llm: LLMConnector;
  private bridge: OpenMontageBridge;
  private voicebox: VoiceboxTTS;

  constructor(
    llm: LLMConnector,
    bridge: OpenMontageBridge,
    voicebox = new VoiceboxTTS(),
  ) {
    this.llm = llm;
    this.bridge = bridge;
    this.voicebox = voicebox;
  }

  isAvailable(): boolean {
    return this.bridge.isInstalled();
  }

  /** Full production: script -> narration -> Remotion composition -> render. */
  async produceVideo(brief: VideoBrief): Promise<VideoResult> {
    if (!this.isAvailable()) {
      throw new Error('OpenMontage not installed — cannot produce video');
    }

    const script = brief.script || (await this.generateScript(brief));
    const slug = this.slugify(brief.title || script.title);
    const outDir = this.outputDir(slug);
    fs.mkdirSync(outDir, { recursive: true });

    getLogger().info({ slug, scenes: script.scenes.length }, 'VideoProducer: starting production');

    const narrationPath = await this.produceNarration(script.narration, outDir, brief.voiceProfile);
    const audioSeconds = narrationPath ? await this.audioDurationSeconds(narrationPath) : 0;

    const { entryPath, propsPath, publicDir } = this.writeComposition(slug, script, narrationPath, {
      fps: brief.fps || 30,
      width: brief.width || 1920,
      height: brief.height || 1080,
      audioSeconds,
    });

    const videoPath = path.join(outDir, 'final.mp4');
    const result: ToolRunResult = await this.bridge.runTool('video_compose', {
      operation: 'render',
      output_path: videoPath,
      edit_decisions: {
        render_runtime: 'remotion',
        composition_mode: 'atelier',
        renderer_family: 'bespoke',
        bespoke: {
          entry: entryPath,
          composition_id: COMPOSITION_ID,
          props_path: propsPath,
          public_dir: publicDir,
        },
      },
    });

    if (!result.success) {
      throw new Error(`Remotion render failed: ${result.error || 'unknown error'}`);
    }
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Remotion render reported success but no video at ${videoPath}`);
    }

    getLogger().info({ videoPath, seconds: result.duration_seconds }, 'VideoProducer: production complete');
    return { videoPath, narrationPath: narrationPath || undefined, script, compositionEntry: entryPath };
  }

  /** Ask the LLM for a script (narration + scene plan) for the brief. */
  async generateScript(brief: VideoBrief): Promise<VideoScript> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a video scriptwriter for Umbra OS. Given a brief, produce a short explainer script ' +
          '(30-90 seconds, 4-7 scenes) as STRICT JSON only — no markdown, no prose. Shape:\n' +
          '{\n' +
          '  "title": "Video title",\n' +
          '  "narration": "Full narration text, 2-4 sentences.",\n' +
          '  "scenes": [\n' +
          '    {"type": "title", "title": "Hook line"},\n' +
          '    {"type": "bullets", "title": "Section label", "lines": ["point 1", "point 2", "point 3"]},\n' +
          '    {"type": "quote", "text": "memorable one-liner"},\n' +
          '    {"type": "text", "text": "paragraph shown on screen"}\n' +
          '  ]\n' +
          '}\n' +
          'Scene types allowed: title, bullets, quote, text. Narration must flow with the scenes.',
      },
      {
        role: 'user',
        content: `Brief: ${brief.description}\nStyle: ${brief.style || 'clean, minimal, professional'}`,
      },
    ];

    const result = await this.llm.complete(messages, 'fast', { temperature: 0.6 });
    const parsed = this.parseScriptJson(result.content);
    if (!parsed) {
      throw new Error(`Could not parse script JSON from LLM:\n${result.content.slice(0, 500)}`);
    }
    return parsed;
  }

  /** Narration audio via Voicebox (cloned voice) with Piper fallback. */
  private async produceNarration(text: string, outDir: string, voiceProfile?: string): Promise<string | null> {
    if (!text.trim()) return null;
    const outPath = path.join(outDir, 'narration.wav');

    if (await this.voicebox.isRunning()) {
      try {
        const audio = await this.voicebox.speak(text, { profile: voiceProfile });
        const dest = path.join(outDir, path.basename(audio));
        if (audio !== dest) fs.copyFileSync(audio, dest);
        getLogger().info({ profile: voiceProfile || 'default' }, 'Narration: voicebox');
        return dest;
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'Voicebox narration failed — falling back to piper');
      }
    }

    const piperModel = this.resolvePiperModel();
    const piper = await this.bridge.runTool('piper_tts', { text, output_path: outPath, model: piperModel });
    if (!piper.success) throw new Error(`Piper TTS failed: ${piper.error || 'unknown error'}`);
    getLogger().info({ model: piperModel }, 'Narration: piper');
    return outPath;
  }

  /** Piper looks for models relative to its data dir; default to the standard
   *  `~/.piper/models` location so a downloaded voice is actually found. */
  private resolvePiperModel(): string {
    const candidates = [
      path.join(process.env['USERPROFILE'] || '.', '.piper', 'models', 'en_US-lessac-medium'),
      path.join(process.env['USERPROFILE'] || '.', '.local', 'share', 'piper_voices', 'en_US-lessac-medium'),
      'en_US-lessac-medium',
    ];
    for (const c of candidates) {
      if (fs.existsSync(`${c}.onnx`)) return c;
    }
    return candidates[0];
  }

  /** Write a hand-authored Remotion composition (atelier) + props JSON. */
  private writeComposition(
    slug: string,
    script: VideoScript,
    narrationPath: string | null,
    cfg: { fps: number; width: number; height: number; audioSeconds: number },
  ): { entryPath: string; propsPath: string; publicDir: string } {
    const projectDir = path.join(COMPOSER_DIR, 'projects', slug);
    const publicDir = path.join(projectDir, 'public');
    fs.mkdirSync(publicDir, { recursive: true });

    const entryPath = path.join(projectDir, 'index.tsx');
    const propsPath = path.join(projectDir, 'props.json');

    const audioFilename = narrationPath ? path.basename(narrationPath) : null;
    if (audioFilename) {
      fs.copyFileSync(narrationPath!, path.join(publicDir, audioFilename));
    }

    const sceneSeconds = script.scenes.reduce((sum, s) => sum + this.sceneSeconds(s), 0);
    const minDuration = sceneSeconds + 1.5;
    const totalSeconds = Math.max(minDuration, cfg.audioSeconds + 1.2);
    const durationInFrames = Math.max(30, Math.round(totalSeconds * cfg.fps));

    const props = {
      title: script.title,
      scenes: script.scenes.map(s => ({ ...s, seconds: this.sceneSeconds(s) })),
      audioFile: audioFilename,
    };
    fs.writeFileSync(propsPath, JSON.stringify(props, null, 2), 'utf-8');

    fs.writeFileSync(entryPath, this.compositionTemplate(COMPOSITION_ID, cfg.fps, cfg.width, cfg.height, durationInFrames), 'utf-8');
    getLogger().info({ entryPath, durationInFrames }, 'VideoProducer: wrote composition');

    return { entryPath, propsPath, publicDir };
  }

  private compositionTemplate(
    id: string,
    fps: number,
    width: number,
    height: number,
    durationInFrames: number,
  ): string {
    return `import React from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, staticFile, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { registerRoot } from 'remotion';

type Scene = { type: 'title' | 'bullets' | 'quote' | 'text'; title?: string; lines?: string[]; text?: string; seconds: number };

type UmbraProps = { title: string; scenes: Scene[]; audioFile: string | null };

const COLORS = { bg: '#0b0d12', fg: '#f4f6fb', dim: '#9aa3b2', accent: '#6c8cff' };

const fadeIn = (frame: number, delay: number, dur = 20) =>
  interpolate(frame, [delay, delay + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const riseIn = (frame: number, delay: number) => {
  const s = spring({ frame: frame - delay, fps: 30, config: { damping: 200 } });
  return { opacity: fadeIn(frame, delay, 10), transform: \`translateY(\${(1 - s) * 40}px)\` };
};

const TitleScene: React.FC<{ text: string; sub?: string }> = ({ text, sub }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeOut = interpolate(frame, [durationInFrames - 20, durationInFrames], [1, 0]);
  const style: React.CSSProperties = { ...riseIn(frame, 4), color: COLORS.fg, fontSize: 88, fontWeight: 800, letterSpacing: '-0.02em', textAlign: 'center', maxWidth: 1500, lineHeight: 1.1, opacity: fadeIn(frame, 4, 24) * fadeOut };
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 80 }}>
      <div style={style}>{text}</div>
      {sub ? <div style={{ marginTop: 28, color: COLORS.dim, fontSize: 34, opacity: fadeIn(frame, 24) * fadeOut }}>{sub}</div> : null}
    </AbsoluteFill>
  );
};

const BulletsScene: React.FC<{ title?: string; lines: string[] }> = ({ title, lines }) => (
  <AbsoluteFill style={{ justifyContent: 'center', padding: 120 }}>
    {title ? <div style={{ color: COLORS.accent, fontSize: 36, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 40, opacity: fadeIn(useCurrentFrame(), 2) }}>{title}</div> : null}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {lines.map((line, i) => <Bullet key={i} line={line} index={i} />)}
    </div>
  </AbsoluteFill>
);

const Bullet: React.FC<{ line: string; index: number }> = ({ line, index }) => {
  const frame = useCurrentFrame();
  const delay = 4 + index * 12;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, ...riseIn(frame, delay), opacity: fadeIn(frame, delay, 12) }}>
      <div style={{ width: 14, height: 14, borderRadius: 7, background: COLORS.accent, flexShrink: 0 }} />
      <div style={{ color: COLORS.fg, fontSize: 44, lineHeight: 1.25 }}>{line}</div>
    </div>
  );
};

const QuoteScene: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 120 }}>
      <div style={{ color: COLORS.fg, fontSize: 56, fontStyle: 'italic', textAlign: 'center', maxWidth: 1400, lineHeight: 1.35, ...riseIn(frame, 4), opacity: fadeIn(frame, 4, 20) }}>{text}</div>
    </AbsoluteFill>
  );
};

const TextScene: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: 120 }}>
      <div style={{ color: COLORS.fg, fontSize: 40, lineHeight: 1.5, maxWidth: 1500, ...riseIn(frame, 4), opacity: fadeIn(frame, 4, 20) }}>{text}</div>
    </AbsoluteFill>
  );
};

const UmbraProduction: React.FC<UmbraProps> = ({ scenes, audioFile }) => {
  const { fps } = useVideoConfig();
  let cursor = 0;
  const withAudio = audioFile ? <Audio src={staticFile(audioFile)} /> : null;
  return (
    <AbsoluteFill style={{ background: COLORS.bg, fontFamily: 'Segoe UI, Roboto, sans-serif' }}>
      {withAudio}
      {scenes.map((scene, i) => {
        const start = cursor * fps;
        cursor += scene.seconds;
        return (
          <Sequence key={i} from={start} durationInFrames={scene.seconds * fps}>
            {scene.type === 'title' && <TitleScene text={scene.title || ''} />}
            {scene.type === 'bullets' && <BulletsScene title={scene.title} lines={scene.lines || []} />}
            {scene.type === 'quote' && <QuoteScene text={scene.text || ''} />}
            {scene.type === 'text' && <TextScene text={scene.text || ''} />}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const RemotionRoot: React.FC = () => (
  <Composition id="${id}" component={UmbraProduction} durationInFrames={${durationInFrames}} fps={${fps}} width={${width}} height={${height}} defaultProps={{ title: '', scenes: [], audioFile: null }} />
);

registerRoot(RemotionRoot);
`;
  }

  private parseScriptJson(content: string): VideoScript | null {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const obj = JSON.parse(match[0]);
      if (!obj.title || !obj.narration || !Array.isArray(obj.scenes) || obj.scenes.length === 0) return null;
      const scenes: VideoScene[] = obj.scenes
        .filter((s: any) => s && typeof s.type === 'string')
        .map((s: any) => ({
          type: s.type,
          title: s.title,
          lines: Array.isArray(s.lines) ? s.lines.map(String) : undefined,
          text: s.text,
          seconds: Number(s.seconds) > 0 ? Number(s.seconds) : undefined,
        }));
      return { title: String(obj.title), narration: String(obj.narration), scenes };
    } catch {
      return null;
    }
  }

  private sceneSeconds(scene: VideoScene): number {
    return Math.max(scene.seconds || 0, SCENE_MIN_SECONDS[scene.type] || 3);
  }

  private slugify(s: string): string {
    return (
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'video'
    );
  }

  private outputDir(slug: string): string {
    const base = process.env['UMBRA_VIDEO_DIR'] || path.join(process.env['USERPROFILE'] || '.', '.umbra', 'videos');
    return path.join(base, slug);
  }

  private audioDurationSeconds(file: string): Promise<number> {
    return new Promise(resolve => {
      const child = spawn(this.ffprobe(), [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file,
      ], { windowsHide: true });
      let out = '';
      child.stdout.on('data', d => (out += d.toString()));
      child.on('close', () => {
        const n = parseFloat(out.trim());
        resolve(Number.isFinite(n) ? n : 0);
      });
      child.on('error', () => resolve(0));
    });
  }

  /** ffprobe can live under WinGet Packages if not on PATH (winget installs
   *  add it to PATH only for future shells). */
  private ffprobe(): string {
    if (process.env['PATH']?.split(path.delimiter).some(p => /ffmpeg|ffprobe/i.test(p))) return 'ffprobe';
    const roots = [process.env['LOCALAPPDATA'], process.env['PROGRAMDATA']];
    for (const root of roots) {
      if (!root) continue;
      const dir = path.join(root, 'Microsoft', 'WinGet', 'Packages');
      if (!fs.existsSync(dir)) continue;
      const found = this.findFfprobe(dir);
      if (found) return found;
    }
    return 'ffprobe';
  }

  private findFfprobe(dir: string): string | undefined {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const exe = path.join(dir, entry.name, 'bin', 'ffprobe.exe');
        if (fs.existsSync(exe)) return exe;
        const nested = this.findFfprobe(path.join(dir, entry.name));
        if (nested) return nested;
      }
    } catch {
      // ignore
    }
    return undefined;
  }
}
