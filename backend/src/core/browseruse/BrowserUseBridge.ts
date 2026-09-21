import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { getLogger } from '../Logger';

export interface BridgeSubmitOptions {
  task: string;
  stopFile: string;
  maxSteps?: number;
  model?: 'fast' | 'reasoning';
  timeoutMs?: number;
  onProgress?: (info: string, n: number) => void;
}

export interface BridgeResult {
  ok: boolean;
  aborted?: boolean;
  result?: string;
  url?: string;
  steps?: number;
  seconds?: number;
  error?: string;
}

interface PendingRequest {
  resolve: (r: BridgeResult) => void;
  onProgress?: (info: string, n: number) => void;
  timer: NodeJS.Timeout;
}

export class BrowserUseBridge {
  private process: ChildProcess | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private buffer: string = '';

  constructor(
    private pythonPath: string,
    private scriptPath: string,
  ) {}

  isReady(): boolean {
    return !!this.process && !this.process.killed;
  }

  async start(): Promise<boolean> {
    if (this.process && !this.process.killed) return true;
    if (!fs.existsSync(this.pythonPath) || !fs.existsSync(this.scriptPath)) {
      getLogger().warn('BrowserUseBridge: python or bridge script missing — fast engine disabled');
      return false;
    }

    this.process = spawn(this.pythonPath, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout!.on('data', chunk => this.onData(chunk.toString()));
    this.process.stderr!.on('data', chunk => {
      getLogger().debug({ msg: chunk.toString().trim() }, 'BrowserUseBridge: stderr');
    });
    this.process.on('exit', () => {
      this.process = null;
      const left = this.pending;
      this.pending = new Map();
      for (const [, p] of left) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'bridge process exited' });
      }
    });
    this.process.on('error', err => {
      getLogger().error({ err: err.message }, 'BrowserUseBridge: spawn failed');
      this.process = null;
    });

    getLogger().info('BrowserUseBridge: fast engine started');
    return true;
  }

  submit(options: BridgeSubmitOptions): Promise<BridgeResult> {
    return new Promise(resolve => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'bridge timeout' });
      }, options.timeoutMs || 360000);

      this.pending.set(id, {
        resolve,
        onProgress: options.onProgress,
        timer,
      });

      const line = JSON.stringify({
        id,
        task: options.task,
        stop_file: options.stopFile,
        max_steps: options.maxSteps || 25,
        model: options.model || 'fast',
      });
      this.process?.stdin!.write(line + '\n');
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    try { proc.kill(); } catch { }
    try {
      await new Promise<void>(resolve => {
        proc.once('exit', () => resolve());
        setTimeout(() => resolve(), 2000);
      });
    } catch { }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        getLogger().debug({ line: line.substring(0, 200) }, 'BrowserUseBridge: unparseable line');
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = String(msg.id || '');
    const req = this.pending.get(id);
    if (!req) return;

    if (msg.event === 'step') {
      req.onProgress?.(String(msg.info || ''), Number(msg.n || 0));
      return;
    }

    if (msg.event === 'done') {
      clearTimeout(req.timer);
      this.pending.delete(id);
      req.resolve({
        ok: msg.ok === true,
        aborted: msg.aborted === true,
        result: msg.result ? String(msg.result) : undefined,
        url: msg.url ? String(msg.url) : undefined,
        steps: msg.steps != null ? Number(msg.steps) : undefined,
        seconds: msg.seconds != null ? Number(msg.seconds) : undefined,
        error: msg.error ? String(msg.error) : undefined,
      });
    }
  }
}
