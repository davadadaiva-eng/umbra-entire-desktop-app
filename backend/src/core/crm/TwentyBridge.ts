import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import { getLogger } from '../Logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TwentyConfig {
  serverUrl: string;
  port: number;
  pgPassword: string;
  encryptionKey: string;
  appSecret: string;
  tag?: string;
}

export interface TwentyStatus {
  running: boolean;
  url: string;
  healthy: boolean;
  uptimeMs?: number;
  error?: string;
}

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; path?: string[] }>;
}

// ---------------------------------------------------------------------------
// TwentyBridge
// ---------------------------------------------------------------------------

export class TwentyBridge {
  private dockerDir: string;
  private dataDir: string;
  private composeFile: string;
  private envFile: string;
  private config: TwentyConfig;
  private startedAt: number = 0;

  constructor(dockerDir: string, dataDir: string, config?: Partial<TwentyConfig>) {
    this.dockerDir = dockerDir;
    this.dataDir = path.join(dataDir, 'twenty');
    this.composeFile = path.join(dockerDir, 'docker-compose.yml');
    this.envFile = path.join(this.dataDir, '.env');
    this.config = {
      serverUrl: config?.serverUrl ?? 'http://localhost:3000',
      port: config?.port ?? 3000,
      pgPassword: config?.pgPassword ?? this.randomPassword(),
      encryptionKey: config?.encryptionKey ?? crypto.randomBytes(32).toString('base64'),
      appSecret: config?.appSecret ?? crypto.randomBytes(32).toString('hex'),
      tag: config?.tag ?? 'latest',
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  isAvailable(): boolean {
    return fs.existsSync(this.composeFile);
  }

  isRunning(): boolean {
    return this.startedAt > 0;
  }

  // ── Environment setup ──────────────────────────────────────

  private ensureEnv(): void {
    const env = [
      `TAG=${this.config.tag}`,
      `PG_DATABASE_USER=postgres`,
      `PG_DATABASE_PASSWORD=${this.config.pgPassword}`,
      `PG_DATABASE_HOST=db`,
      `PG_DATABASE_PORT=5432`,
      `PG_DATABASE_NAME=default`,
      `SERVER_URL=${this.config.serverUrl}`,
      `REDIS_URL=redis://redis:6379`,
      `ENCRYPTION_KEY=${this.config.encryptionKey}`,
      `APP_SECRET=${this.config.appSecret}`,
      `STORAGE_TYPE=local`,
      `DISABLE_DB_MIGRATIONS=`,
      `DISABLE_CRON_JOBS_REGISTRATION=`,
      '',
    ].join('\n');
    fs.writeFileSync(this.envFile, env, 'utf-8');
    // Also write .env to the docker dir so docker compose picks it up automatically
    fs.writeFileSync(path.join(this.dockerDir, '.env'), env, 'utf-8');
  }

  private randomPassword(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  // ── Docker Compose lifecycle ───────────────────────────────

  async start(): Promise<TwentyStatus> {
    if (!this.isAvailable()) {
      return { running: false, url: '', healthy: false, error: 'Twenty docker-compose.yml not found in ' + this.dockerDir };
    }

    this.ensureEnv();

    try {
      // Pull images first
      await this.compose(['pull']);
      // Start the stack
      await this.compose(['up', '-d', '--wait', '--wait-timeout', '120']);
      this.startedAt = Date.now();
      getLogger().info({ url: this.config.serverUrl }, 'Twenty CRM started');
    } catch (err: any) {
      getLogger().error({ err: err.message }, 'Twenty CRM failed to start');
      return { running: false, url: this.config.serverUrl, healthy: false, error: err.message };
    }

    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (!this.isRunning()) return;
    try {
      await this.compose(['down']);
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Twenty CRM stop had errors');
    }
    this.startedAt = 0;
  }

  async getStatus(): Promise<TwentyStatus> {
    const healthy = await this.healthCheck();
    return {
      running: this.isRunning(),
      url: this.config.serverUrl,
      healthy,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : undefined,
    };
  }

  private async healthCheck(): Promise<boolean> {
    try {
      const text = await this.httpGet('/healthz');
      return text.includes('ok') || text.includes('healthy');
    } catch {
      return false;
    }
  }

  // ── GraphQL ────────────────────────────────────────────────

  async graphql(query: string, variables?: Record<string, unknown>): Promise<GraphQLResult> {
    const body = JSON.stringify({ query, variables });
    const text = await this.httpPost('/graphql', body);
    return JSON.parse(text) as GraphQLResult;
  }

  /** Convenience: run a simple GraphQL query and return the data. */
  async query(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.graphql(query, variables);
    if (result.errors && result.errors.length > 0) {
      throw new Error(`GraphQL error: ${result.errors[0].message}`);
    }
    return result.data ?? {};
  }

  // ── REST helpers ───────────────────────────────────────────

  private httpGet(pathname: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, this.config.serverUrl);
      const req = http.get(url, { timeout: 10000 }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  private httpPost(pathname: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, this.config.serverUrl);
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── Docker Compose exec ────────────────────────────────────

  private compose(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', '-f', this.composeFile, '--project-name', 'twenty', ...args], {
        cwd: this.dockerDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env as Record<string, string>,
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', d => out += d);
      child.stderr.on('data', d => err += d);
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve(out);
        else reject(new Error(err || `docker compose exit ${code}`));
      });
    });
  }
}