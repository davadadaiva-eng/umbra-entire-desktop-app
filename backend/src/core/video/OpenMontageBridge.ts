import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../Logger';

export interface OpenMontageToolInfo {
  name: string;
  capability: string;
  provider: string;
  runtime: string;
  description: string;
}

export interface ToolRunResult {
  success: boolean;
  data: Record<string, unknown>;
  artifacts: string[];
  error?: string;
  cost_usd: number;
  duration_seconds: number;
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_DIR = path.join(PROJECT_ROOT, 'external', 'OpenMontage');
const PYTHON = path.join(REPO_DIR, '.venv', 'Scripts', 'python.exe');
const DRIVER = path.join(REPO_DIR, 'scripts', 'umbra_bridge.py');

export class OpenMontageBridge {
  private tools?: OpenMontageToolInfo[];
  private spawnTimeoutMs = 45 * 60 * 1000;

  isInstalled(): boolean {
    return fs.existsSync(PYTHON) && fs.existsSync(DRIVER);
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  async listTools(force = false): Promise<OpenMontageToolInfo[]> {
    if (this.tools && !force) return this.tools;
    if (!this.isInstalled()) return [];
    const out = await this.runJson(['--list']);
    if (!out) return [];
    this.tools = (out.tools as OpenMontageToolInfo[]) || [];
    return this.tools!;
  }

  async hasTool(name: string): Promise<boolean> {
    const tools = await this.listTools();
    return tools.some(t => t.name === name);
  }

  async runTool(name: string, inputs: Record<string, unknown> = {}): Promise<ToolRunResult> {
    if (!this.isInstalled()) {
      throw new Error('OpenMontage not installed — run external/OpenMontage setup first');
    }
    const args = ['--tool', name, '--params', JSON.stringify(inputs)];
    const raw = await this.runJson(args);
    if (raw && raw.error && !('success' in raw)) {
      throw new Error(`OpenMontage bridge: ${String(raw.error)}`);
    }
    return (raw as unknown as ToolRunResult) ?? { success: false, error: 'empty bridge output' };
  }

  private runJson(args: string[]): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(PYTHON, [DRIVER, ...args], {
        cwd: REPO_DIR,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`OpenMontage bridge timed out after ${this.spawnTimeoutMs / 1000}s (${args.join(' ')})`));
      }, this.spawnTimeoutMs);

      child.stdout.on('data', d => (stdout += d.toString()));
      child.stderr.on('data', d => (stderr += d.toString()));
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', code => {
        clearTimeout(timer);
        const lastLine = stdout
          .split(/\r?\n/)
          .filter(l => l.trim())
          .pop();
        if (lastLine) {
          try {
            resolve(JSON.parse(lastLine));
            return;
          } catch {
            getLogger().debug({ stdout, stderr }, 'Bridge output was not JSON');
          }
        }
        if (code === 0) {
          resolve(null);
        } else {
          reject(new Error(`OpenMontage bridge exit ${code}: ${stderr.trim().split('\n').pop()}`));
        }
      });
    });
  }
}
