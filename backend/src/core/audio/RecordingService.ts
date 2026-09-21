import * as fs from 'fs';
import * as path from 'path';
import { LoopbackRecorder } from './LoopbackRecorder';
import { MicRecorder } from './MicRecorder';
import { getLogger } from '../Logger';

export interface Recording {
  id: string;
  path: string;
  source: 'loopback' | 'mic' | 'unknown';
  durationMs: number;
  createdAt: string;
}

export class RecordingService {
  private loopback: LoopbackRecorder;
  private mic: MicRecorder;
  private dir: string;
  private active: Map<string, { source: 'loopback' | 'mic'; startedAt: number }> = new Map();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'recordings');
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this.loopback = new LoopbackRecorder({ dataDir });
    this.mic = new MicRecorder();
  }

  get available(): boolean { return this.loopback.available || process.platform === 'win32'; }

  async startLoopback(seconds?: number): Promise<{ id: string }> {
    const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.active.set(id, { source: 'loopback', startedAt: Date.now() });
    // Fire-and-forget background capture to file
    const outPath = path.join(this.dir, `${id}.wav`);
    void this.loopback.record(seconds || 60).then(buf => {
      if (buf) fs.writeFileSync(outPath, buf);
      getLogger().info({ id, outPath }, 'Loopback recording saved');
    }).catch(() => {});
    return { id };
  }

  async startMic(_maxSeconds: number = 30): Promise<{ id: string }> {
    const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.active.set(id, { source: 'mic', startedAt: Date.now() });
    await this.mic.start();
    return { id };
  }

  async stop(id: string): Promise<Recording | null> {
    const meta = this.active.get(id);
    if (!meta) return null;
    this.active.delete(id);
    const startedAt = meta.startedAt;
    const durationMs = Date.now() - startedAt;
    if (meta.source === 'mic') {
      try {
        const buf = await this.mic.stop();
        const outPath = path.join(this.dir, `${id}.wav`);
        if (buf && buf.length > 0) fs.writeFileSync(outPath, buf);
        return { id, path: outPath, source: 'mic', durationMs, createdAt: new Date().toISOString() };
      } catch { return null; }
    }
    // loopback already saving async; just report
    const outPath = path.join(this.dir, `${id}.wav`);
    return { id, path: outPath, source: 'loopback', durationMs, createdAt: new Date().toISOString() };
  }

  list(): Recording[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.wav')).sort().reverse();
    return files.map(f => {
      const full = path.join(this.dir, f);
      const stat = fs.statSync(full);
      return { id: f.replace('.wav', ''), path: full, source: 'unknown' as const, durationMs: 0, createdAt: stat.mtime.toISOString() };
    });
  }

  getPath(id: string): string | null {
    const p = path.join(this.dir, `${id}.wav`);
    return fs.existsSync(p) ? p : null;
  }
}
