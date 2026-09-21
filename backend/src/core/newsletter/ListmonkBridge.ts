import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import { getLogger } from '../Logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListmonkStatus {
  running: boolean;
  url: string;
  healthy: boolean;
  uptimeMs?: number;
  error?: string;
}

export interface Subscriber {
  id?: number;
  email: string;
  name?: string;
  status?: 'enabled' | 'disabled' | 'blocklisted';
  lists?: number[];
  attribs?: Record<string, unknown>;
}

export interface ListData {
  id?: number;
  name: string;
  type: 'public' | 'private' | 'double_opt_in';
  description?: string;
}

export interface CampaignData {
  name: string;
  subject: string;
  lists: number[];
  from_email?: string;
  content_type?: 'plain' | 'html' | 'markdown';
  body: string;
  send_at?: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// ListmonkBridge
// ---------------------------------------------------------------------------

export class ListmonkBridge {
  private dockerDir: string;
  private dataDir: string;
  private composeFile: string;
  private envFile: string;
  private baseUrl: string;
  private adminUser: string;
  private adminPassword: string;
  private startedAt: number = 0;

  constructor(dockerDir: string, dataDir: string, port: number = 9000) {
    this.dockerDir = dockerDir;
    this.dataDir = path.join(dataDir, 'listmonk');
    this.composeFile = path.join(dockerDir, 'docker-compose.yml');
    this.envFile = path.join(this.dataDir, '.env');
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.adminUser = 'admin';
    this.adminPassword = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(this.dataDir, { recursive: true });
    // Also create uploads dir
    fs.mkdirSync(path.join(this.dataDir, 'uploads'), { recursive: true });
  }

  isAvailable(): boolean {
    return fs.existsSync(this.composeFile);
  }

  isRunning(): boolean {
    return this.startedAt > 0;
  }

  // ── Setup ──────────────────────────────────────────────────

  private ensureEnv(): void {
    const env = [
      `LISTMONK_ADMIN_USER=${this.adminUser}`,
      `LISTMONK_ADMIN_PASSWORD=${this.adminPassword}`,
      '',
    ].join('\n');
    fs.writeFileSync(this.envFile, env, 'utf-8');
  }

  getAdminCredentials(): { user: string; password: string } {
    return { user: this.adminUser, password: this.adminPassword };
  }

  // ── Docker Compose lifecycle ───────────────────────────────

  async start(): Promise<ListmonkStatus> {
    if (!this.isAvailable()) {
      return { running: false, url: '', healthy: false, error: 'docker-compose.yml not found in ' + this.dockerDir };
    }

    this.ensureEnv();

    try {
      await this.compose(['pull']);
      await this.compose(['up', '-d', '--wait', '--wait-timeout', '120']);
      this.startedAt = Date.now();
      getLogger().info({ url: this.baseUrl }, 'Listmonk started');
    } catch (err: any) {
      getLogger().error({ err: err.message }, 'Listmonk failed to start');
      return { running: false, url: this.baseUrl, healthy: false, error: err.message };
    }

    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (!this.isRunning()) return;
    try {
      await this.compose(['down']);
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Listmonk stop had errors');
    }
    this.startedAt = 0;
  }

  async getStatus(): Promise<ListmonkStatus> {
    let healthy = false;
    try {
      const result = await this.apiGet('');
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      healthy = text.includes('listmonk') || text.length > 0;
    } catch { }
    return {
      running: this.isRunning(),
      url: this.baseUrl,
      healthy,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : undefined,
    };
  }

  // ── API: Subscribers ───────────────────────────────────────

  async createSubscriber(sub: Subscriber): Promise<Subscriber> {
    const data = await this.apiPost('/api/subscribers', sub);
    return data as Subscriber;
  }

  async listSubscribers(query?: string, page?: number, perPage?: number): Promise<{ results: Subscriber[]; total: number }> {
    const params: string[] = [];
    if (query) params.push(`query=${encodeURIComponent(query)}`);
    if (page) params.push(`page=${page}`);
    if (perPage) params.push(`per_page=${perPage}`);
    const qs = params.length > 0 ? '?' + params.join('&') : '';
    const data = await this.apiGet(`/api/subscribers${qs}`);
    return data as { results: Subscriber[]; total: number };
  }

  async getSubscriber(id: number): Promise<Subscriber> {
    return this.apiGet(`/api/subscribers/${id}`) as Promise<Subscriber>;
  }

  async deleteSubscriber(id: number): Promise<unknown> {
    return this.apiDelete(`/api/subscribers/${id}`);
  }

  // ── API: Lists ─────────────────────────────────────────────

  async createList(list: ListData): Promise<ListData> {
    const data = await this.apiPost('/api/lists', list);
    return data as ListData;
  }

  async listLists(): Promise<{ results: ListData[]; total: number }> {
    const data = await this.apiGet('/api/lists');
    return data as { results: ListData[]; total: number };
  }

  // ── API: Campaigns ─────────────────────────────────────────

  async createCampaign(campaign: CampaignData): Promise<unknown> {
    return this.apiPost('/api/campaigns', campaign);
  }

  async listCampaigns(): Promise<{ results: unknown[]; total: number }> {
    const data = await this.apiGet('/api/campaigns');
    return data as { results: unknown[]; total: number };
  }

  async getCampaign(id: number): Promise<unknown> {
    return this.apiGet(`/api/campaigns/${id}`);
  }

  // ── API: Transactional emails ──────────────────────────────

  async sendTransactional(opts: {
    subscriber_id?: number;
    subscriber_email?: string;
    template_id: number;
    data?: Record<string, unknown>;
    headers?: Record<string, string>;
  }): Promise<unknown> {
    return this.apiPost('/api/tx', opts);
  }

  // ── HTTP helpers ───────────────────────────────────────────

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.adminUser}:${this.adminPassword}`).toString('base64');
  }

  private apiGet(pathname: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, this.baseUrl);
      const req = http.get(url, {
        headers: { Authorization: this.authHeader() },
        timeout: 15000,
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Listmonk API: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  private apiPost(pathname: string, body: unknown): Promise<unknown> {
    return this.apiRequest('POST', pathname, body);
  }

  private apiDelete(pathname: string): Promise<unknown> {
    return this.apiRequest('DELETE', pathname);
  }

  private apiRequest(method: string, pathname: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, this.baseUrl);
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader(),
        },
        timeout: 30000,
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // ── Docker Compose exec ────────────────────────────────────

  private compose(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', '-f', this.composeFile, '--project-name', 'listmonk', ...args], {
        cwd: this.dockerDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(process.env as Record<string, string>), COMPOSE_ENV_FILE: this.envFile },
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