/**
 * HermesAgentBridge — delegates agent tasks to the built-in dedicated
 * reasoning engine (the local `hermes` CLI).
 *
 * Uses the documented one-shot CLI mode: `hermes -z "<prompt>"` returns only the
 * agent's final response text on stdout (no banner, no session lines), which
 * makes it safe for programmatic callers. Windows-native installs live under
 * %LOCALAPPDATA%\hermes; the binary is auto-detected unless overridden.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

export interface HermesTaskOptions {
  provider?: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface HermesTaskResult {
  ok: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export class HermesAgentBridge {
  private bin: string;
  private timeoutMs: number;
  private hermesHome?: string;

  constructor(options: { bin?: string; timeoutMs?: number; hermesHome?: string } = {}) {
    this.bin = options.bin || this.detectBin();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.hermesHome = options.hermesHome;
  }

  /**
   * Resolve hermes' user config.yaml. Resolution order mirrors the CLI's:
   * HERMES_HOME env var, then the platform default (%LOCALAPPDATA%\hermes on
   * Windows, ~/.hermes elsewhere).
   */
  configPath(): string {
    const home =
      this.hermesHome ||
      process.env['HERMES_HOME'] ||
      (process.platform === 'win32'
        ? `${process.env['LOCALAPPDATA'] || ''}\\hermes`
        : `${process.env['HOME'] || ''}/.hermes`);
    return path.join(home, 'config.yaml');
  }

  /**
   * Register Umbra's built-in MCP server (the connector bridge) with the agent
   * CLI by adding/updating the `umbra` entry under `mcp_servers` in hermes'
   * user config — so the hidden engine can call every catalog connector
   * through Umbra (vault credentials, same router as the agent loop).
   *
   * Returns false when the engine is not installed or the config write fails;
   * never throws. Safe to call on every boot: already-registered servers are
   * left untouched.
   */
  async registerMcpBridge(url: string): Promise<boolean> {
    if (!this.isInstalled()) return false;
    const configPath = this.configPath();
    try {
      let text = '';
      if (fs.existsSync(configPath)) text = fs.readFileSync(configPath, 'utf-8');
      if (this.hasMcpServer(text, 'umbra')) return true;
      const updated = this.upsertMcpServer(text, url);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, updated, 'utf-8');
      getLogger().info({ configPath, url }, 'Agent engine MCP bridge registered');
      return true;
    } catch (err) {
      getLogger().warn({ err }, 'Failed to register agent engine MCP bridge');
      return false;
    }
  }

  /**
   * Provision the engine's runtime credentials from Umbra's own provider
   * config, so delegated agentic work runs with the same key the app already
   * uses — the user never configures a second provider. `env` maps provider
   * env-var names (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) to values; entries
   * are upserted into the engine's `.env` (hermes home). No-op when the
   * engine is not installed. Never throws.
   */
  async syncProviderCredentials(env: Record<string, string>): Promise<boolean> {
    if (!this.isInstalled()) return false;
    const entries = Object.entries(env).filter(([, v]) => !!v && v.trim().length > 0);
    if (!entries.length) return true;
    const envPath = path.join(path.dirname(this.configPath()), '.env');
    try {
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      let updated = existing;
      for (const [key, value] of entries) {
        updated = this.upsertEnvLine(updated, key, value);
      }
      if (updated !== existing) {
        fs.mkdirSync(path.dirname(envPath), { recursive: true });
        fs.writeFileSync(envPath, updated, 'utf-8');
      }
      getLogger().info({ envPath, keys: entries.map(([k]) => k) }, 'Agent engine credentials provisioned');
      return true;
    } catch (err) {
      getLogger().warn({ err }, 'Failed to provision agent engine credentials');
      return false;
    }
  }

  /** Upsert a `KEY=value` line, preserving every other line in the file. */
  private upsertEnvLine(text: string, key: string, value: string): string {
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    let found = false;
    for (const line of lines) {
      if (new RegExp(`^${key}\\s*=`).test(line)) {
        out.push(`${key}=${value}`);
        found = true;
      } else {
        out.push(line);
      }
    }
    if (!found) out.push(`${key}=${value}`);
    return out.join('\r\n');
  }

  /** True when an uncommented `mcp_servers:` section already lists the server. */
  private hasMcpServer(text: string, name: string): boolean {
    let inSection = false;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (inSection) {
        if (/^\S/.test(line)) inSection = false;
        else if (new RegExp(`^${name}\\s*:`).test(trimmed)) return true;
      } else if (/^mcp_servers\s*:/.test(trimmed)) {
        inSection = true;
      }
    }
    return false;
  }

  /** Insert/update the `umbra` entry under `mcp_servers:` preserving comments. */
  private upsertMcpServer(text: string, url: string): string {
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    const block = ['  umbra:', `    url: ${url}`, '    connect_timeout: 10'];
    let inSection = false;
    let inserted = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        out.push(line);
        continue;
      }
      if (inSection) {
        if (/^\S/.test(line)) {
          // Section ended: emit the block just before the next top-level key.
          out.push(...block, line);
          inserted = true;
          inSection = false;
        } else {
          out.push(line);
        }
      } else if (/^mcp_servers\s*:/.test(trimmed)) {
        inSection = true;
        out.push(line);
      } else {
        out.push(line);
      }
    }
    if (!inserted) {
      if (inSection) out.push(...block);
      else out.push('', 'mcp_servers:', ...block);
    }
    return out.join('\r\n');
  }

  /** Auto-detect the hermes CLI binary across supported Windows layouts. */
  detectBin(): string {
    const local = process.env['LOCALAPPDATA'];
    const home = process.env['USERPROFILE'];
    const candidates = [
      process.env['HERMES_BIN'],
      // Official Windows installer (install.ps1): repo + venv under %LOCALAPPDATA%\hermes.
      local ? `${local}\\hermes\\hermes-agent\\bin\\hermes.exe` : undefined,
      local ? `${local}\\hermes\\bin\\hermes.exe` : undefined,
      local ? `${local}\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe` : undefined,
      home ? `${home}\\.hermes\\venv\\Scripts\\hermes.exe` : undefined,
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return 'hermes';
  }

  isInstalled(): boolean {
    if (this.bin !== 'hermes') {
      return fs.existsSync(this.bin);
    }
    return process.env['HERMES_BIN'] !== undefined || this.hasOnPath('hermes');
  }

  private hasOnPath(bin: string): boolean {
    const pathDirs = (process.env['PATH'] || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
    return pathDirs.some(dir => {
      try {
        return (
          fs.existsSync(`${dir}\\${bin}.exe`) ||
          fs.existsSync(`${dir}/${bin}`) ||
          fs.existsSync(`${dir}\\${bin}.cmd`) ||
          fs.existsSync(`${dir}/${bin}.cmd`) ||
          fs.existsSync(`${dir}\\${bin}.bat`)
        );
      } catch {
        return false;
      }
    });
  }

  /** Run a single agent task headlessly and return only the final response. */
  async runTask(prompt: string, options: HermesTaskOptions = {}): Promise<HermesTaskResult> {
    if (!this.isInstalled()) {
      return { ok: false, output: '', exitCode: -1, durationMs: 0, error: 'Agent engine not installed' };
    }
    const started = Date.now();
    const args = ['-z', prompt];
    if (options.provider) args.push('--provider', options.provider);
    if (options.model) args.push('-m', options.model);
    // Note: hermes has no --max-turns CLI flag (max_turns is a config key),
    // so it is intentionally not passed on the command line.

    return new Promise<HermesTaskResult>(resolve => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      let child;
      try {
        child = spawn(this.bin, args, { windowsHide: true, shell: process.platform === 'win32' });
      } catch (err) {
        resolve({ ok: false, output: '', exitCode: -1, durationMs: Date.now() - started, error: String(err) });
        return;
      }

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({
          ok: false,
          output: stdout.trim(),
          exitCode: -1,
          durationMs: Date.now() - started,
          timedOut: true,
          error: `Agent task timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
      }, timeoutMs);

      child.stdout.on('data', d => (stdout += d.toString()));
      child.stderr.on('data', d => (stderr += d.toString()));
      child.on('error', err => {
        clearTimeout(timer);
        getLogger().warn({ err }, 'Agent engine spawn failed');
        resolve({ ok: false, output: stdout.trim(), exitCode: -1, durationMs: Date.now() - started, error: String(err) });
      });
      child.on('close', code => {
        clearTimeout(timer);
        const output = stdout.trim();
        const dirty = stderr.trim();
        if (code === 0) {
          resolve({ ok: true, output, exitCode: code, durationMs: Date.now() - started });
        } else {
          resolve({
            ok: false,
            output,
            exitCode: code ?? -1,
            durationMs: Date.now() - started,
            error: dirty.split('\n').pop() || `exit ${code}`,
          });
        }
      });
    });
  }
}