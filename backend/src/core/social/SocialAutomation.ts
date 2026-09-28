import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SocialPlatform = 'x' | 'youtube' | 'instagram';

export interface SocialAction {
  platform: SocialPlatform;
  action: 'post' | 'comment' | 'search' | 'upload' | 'login';
  email: string;
  password: string;
  text?: string;
  comment_text?: string;
  query?: string;
  media_files?: string[];
  video_path?: string;
  title?: string;
  description?: string;
  max_comments?: number;
  max_results?: number;
  headless?: boolean;
}

export interface SocialResult {
  ok: boolean;
  platform?: string;
  action?: string;
  error?: string;
  text_preview?: string;
  commented?: number;
  title?: string;
  results?: Array<{ text: string }>;
}

export interface ScheduledPost {
  id: string;
  platform: SocialPlatform;
  action: 'post' | 'upload';
  scheduledAt: number; // unix ms
  payload: SocialAction;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: SocialResult;
  createdAt: number;
}

export interface SocialStatus {
  pythonAvailable: boolean;
  sessions: Partial<Record<SocialPlatform, boolean>>;
  scheduled: number;
  completed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// SocialAutomation
// ---------------------------------------------------------------------------

const SOCIAL_DIR = 'social';

export class SocialAutomation {
  private pythonPath: string;
  private scriptPath: string;
  private dataDir: string;
  private scheduleFile: string;
  private vault: { resolve: (r: SocialResult) => void; timer: NodeJS.Timeout } | null = null;

  constructor(
    pythonPath: string,
    scriptsRoot: string,
    dataDir: string,
  ) {
    this.pythonPath = pythonPath;
    this.scriptPath = path.join(scriptsRoot, SOCIAL_DIR, 'cli.py');
    this.dataDir = path.join(dataDir, SOCIAL_DIR);
    this.scheduleFile = path.join(this.dataDir, 'schedule.json');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /** Check that the Python CLI is usable. */
  isAvailable(): boolean {
    return fs.existsSync(this.pythonPath) && fs.existsSync(this.scriptPath);
  }

  /** Convenience alias for `isAvailable()` — used by the UI status endpoint. */
  get available(): boolean {
    return this.isAvailable();
  }

  // ── Execute a social action ───────────────────────────────

  async execute(action: SocialAction, timeoutMs: number = 120_000): Promise<SocialResult> {
    if (!this.isAvailable()) {
      getLogger().warn(
        'SocialAutomation: python CLI not available — using no-op fallback that logs "not configured". ' +
          'Install with: cd backend && python -m venv .venv && .venv\\Scripts\\pip install -r scripts/social/requirements.txt && .venv\\Scripts\\python -m playwright install chromium',
      );
      return { ok: false, error: 'Python CLI not available — social automation not configured. Install with: cd backend && python -m venv .venv && .venv\\Scripts\\pip install -r scripts/social/requirements.txt && .venv\\Scripts\\python -m playwright install chromium' };
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      UMBRA_SOCIAL_DIR: this.dataDir,
      PYTHONIOENCODING: 'utf-8',
    };

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.vault = null;
        proc.kill();
        resolve({ ok: false, error: 'social action timed out' });
      }, timeoutMs);

      this.vault = { resolve, timer };

      const proc = spawn(this.pythonPath, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', chunk => { stdout += chunk.toString(); });
      proc.stderr!.on('data', chunk => {
        stderr += chunk.toString();
        getLogger().debug({ msg: chunk.toString().trim() }, 'SocialAutomation: stderr');
      });

      proc.on('close', code => {
        if (this.vault?.timer) clearTimeout(this.vault.timer);
        this.vault = null;

        if (code !== 0) {
          resolve({ ok: false, error: `Python exited ${code}: ${stderr.substring(0, 500)}` });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim() || '{}') as SocialResult;
          resolve(result);
        } catch {
          resolve({ ok: false, error: `Unparseable output: ${stdout.substring(0, 300)}` });
        }
      });

      proc.on('error', err => {
        if (this.vault?.timer) clearTimeout(this.vault.timer);
        this.vault = null;
        resolve({ ok: false, error: `Failed to spawn Python: ${err.message}` });
      });

      const input = JSON.stringify(action);
      proc.stdin!.write(input);
      proc.stdin!.end();
    });
  }

  // ── Scheduling ─────────────────────────────────────────────

  loadSchedule(): ScheduledPost[] {
    try {
      if (!fs.existsSync(this.scheduleFile)) return [];
      const raw = fs.readFileSync(this.scheduleFile, 'utf-8');
      return JSON.parse(raw) as ScheduledPost[];
    } catch {
      return [];
    }
  }

  saveSchedule(posts: ScheduledPost[]): void {
    fs.writeFileSync(this.scheduleFile, JSON.stringify(posts, null, 2), 'utf-8');
  }

  schedule(payload: SocialAction, scheduledAt: number): ScheduledPost {
    const post: ScheduledPost = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      platform: payload.platform,
      action: payload.action as 'post' | 'upload',
      scheduledAt,
      payload,
      status: 'pending',
      createdAt: Date.now(),
    };
    const all = this.loadSchedule();
    all.push(post);
    this.saveSchedule(all);
    getLogger().info({ id: post.id, platform: post.platform, scheduledAt: new Date(scheduledAt).toISOString() }, 'Social: post scheduled');
    return post;
  }

  cancelScheduled(id: string): boolean {
    const all = this.loadSchedule();
    const idx = all.findIndex(p => p.id === id);
    if (idx === -1) return false;
    all.splice(idx, 1);
    this.saveSchedule(all);
    return true;
  }

  getScheduled(): ScheduledPost[] {
    return this.loadSchedule();
  }

  /** Run all due scheduled posts. Call on a timer (e.g. every 30s). */
  async runDue(): Promise<number> {
    const all = this.loadSchedule();
    const now = Date.now();
    const due = all.filter(p => p.status === 'pending' && p.scheduledAt <= now);
    if (due.length === 0) return 0;

    let ran = 0;
    for (const post of due) {
      post.status = 'running';
      this.saveSchedule(all);
      getLogger().info({ id: post.id, platform: post.platform }, 'Social: running scheduled post');
      const result = await this.execute(post.payload);
      post.status = result.ok ? 'done' : 'failed';
      post.result = result;
      this.saveSchedule(all);
      ran++;
    }
    return ran;
  }

  checkSessions(): Partial<Record<SocialPlatform, boolean>> {
    const out: Partial<Record<SocialPlatform, boolean>> = {};
    for (const plat of ['x', 'youtube', 'instagram'] as SocialPlatform[]) {
      const sp = path.join(this.dataDir, `${plat}_state.json`);
      out[plat] = fs.existsSync(sp);
    }
    return out;
  }

  getStatus(): SocialStatus {
    const all = this.loadSchedule();
    return {
      pythonAvailable: this.isAvailable(),
      sessions: this.checkSessions(),
      scheduled: all.filter(p => p.status === 'pending' || p.status === 'running').length,
      completed: all.filter(p => p.status === 'done').length,
      failed: all.filter(p => p.status === 'failed').length,
    };
  }
}