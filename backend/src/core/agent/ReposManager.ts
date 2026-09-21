import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { RepoConfig } from '../../types';
import { getLogger } from '../Logger';

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_BUFFER = MAX_OUTPUT * 2;
const COMMAND_TIMEOUT_MS = 120000;

export interface RepoStatus {
  name: string;
  path: string;
  exists: boolean;
  isGit: boolean;
  branch: string | null;
  lastCommit: string | null;
  dirty: number;
}

export class ReposManager {
  private repos: Map<string, RepoConfig> = new Map();

  constructor(repos: RepoConfig[] = []) {
    for (const repo of repos) {
      this.register(repo.name, repo.path);
    }
  }

  register(name: string, repoPath: string): void {
    const key = this.normalizeName(name);
    if (!key) throw new Error('Repo name must be a non-empty string');
    const resolved = path.resolve(repoPath);
    if (!fsSync.existsSync(resolved)) {
      getLogger().warn({ name, path: resolved }, 'ReposManager: repo path does not exist');
    }
    this.repos.set(key, { name: key, path: resolved });
  }

  listConfigs(): RepoConfig[] {
    return Array.from(this.repos.values());
  }

  resolveRepo(nameOrPath: string): RepoConfig {
    const key = this.normalizeName(nameOrPath);
    const byName = this.repos.get(key);
    if (byName) return byName;
    const byPath = Array.from(this.repos.values()).find(r => {
      const abs = path.resolve(nameOrPath);
      return abs === r.path || abs.startsWith(r.path + path.sep);
    });
    if (byPath) return byPath;
    throw new Error(`Unknown repo: ${nameOrPath}. Registered repos: ${this.repos.size ? Array.from(this.repos.keys()).join(', ') : '(none — add them to config.json "repos")'}`);
  }

  private resolve(repo: string, relPath: string): string {
    const root = this.resolveRepo(repo).path;
    if (typeof relPath !== 'string' || relPath.length === 0) return root;
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Path escapes repo: ${relPath}`);
    }
    return abs;
  }

  async read(repo: string, relPath: string): Promise<string> {
    const abs = this.resolve(repo, relPath);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);
    if (stat.size > MAX_FILE_SIZE) throw new Error(`File too large to read (${stat.size} bytes): ${relPath}`);
    return fs.readFile(abs, 'utf8');
  }

  async write(repo: string, relPath: string, content: string): Promise<{ path: string; bytes: number }> {
    const abs = this.resolve(repo, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { path: relPath, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async list(repo: string, relPath: string = '.'): Promise<string[]> {
    const abs = this.resolve(repo, relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  run(repo: string, command: string, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    const root = this.resolveRepo(repo).path;
    return new Promise(resolve => {
      const child = exec(command, {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        shell: 'cmd.exe',
        env: { ...process.env, UMBRA_REPO_ROOT: root },
      }, (err: Error | null, stdout: string, stderr: string) => {
        const timedOut = !!(err && (err as any).killed && !(err as any).signal);
        const code = err ? ((err as any).code ?? 1) : 0;
        const trim = (s: string) => s.length > MAX_OUTPUT ? s.substring(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} bytes]` : s;
        resolve({ code, stdout: trim(stdout || ''), stderr: trim(stderr || ''), timedOut });
      });
      if (this.pending) this.pending.push(child);
    });
  }

  async gitStatus(repo: string): Promise<RepoStatus> {
    const cfg = this.resolveRepo(repo);
    const isGit = fsSync.existsSync(path.join(cfg.path, '.git'));
    const status: RepoStatus = {
      name: cfg.name,
      path: cfg.path,
      exists: fsSync.existsSync(cfg.path),
      isGit,
      branch: null,
      lastCommit: null,
      dirty: 0,
    };
    if (!isGit) return status;
    try {
      const branch = await this.run(repo, 'git branch --show-current');
      status.branch = branch.stdout.trim() || null;
    } catch { }
    try {
      const commit = await this.run(repo, 'git log -1 --date=short --format="%h %s"');
      status.lastCommit = commit.stdout.trim() || null;
    } catch { }
    try {
      const dirty = await this.run(repo, 'git status --porcelain');
      status.dirty = dirty.stdout.split('\n').filter(Boolean).length;
    } catch { }
    return status;
  }

  async statusAll(): Promise<RepoStatus[]> {
    const results: RepoStatus[] = [];
    for (const repo of this.repos.values()) {
      try {
        results.push(await this.gitStatus(repo.name));
      } catch (err: any) {
        results.push({ name: repo.name, path: repo.path, exists: true, isGit: false, branch: null, lastCommit: null, dirty: 0 });
        getLogger().warn({ repo: repo.name, err: err.message }, 'ReposManager: status failed');
      }
    }
    return results;
  }

  openInEditor(repo: string): { command: string; args: string[] } {
    const root = this.resolveRepo(repo).path;
    const candidates = ['C:\\Program Files\\Microsoft VS Code\\Code.exe', 'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe'];
    const exe = candidates.find(p => fsSync.existsSync(p));
    if (exe) return { command: exe, args: [root] };
    const codeOnPath = process.env['PATH']?.split(';').some(p => fsSync.existsSync(path.join(p, 'code.cmd')));
    if (codeOnPath) return { command: 'code', args: [root] };
    return { command: 'explorer', args: [root] };
  }

  private pending: ReturnType<typeof exec>[] = [];

  close(): void {
    for (const child of this.pending) {
      try { child.kill(); } catch { }
    }
    this.pending = [];
  }

  private normalizeName(name: string): string {
    if (typeof name !== 'string') return '';
    return name.trim().toLowerCase().replace(/[/\\]/g, '-');
  }
}
