import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import Database from 'better-sqlite3';
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
  /** True when the local SQLite CRM fallback is active. */
  local?: boolean;
  /** Human-readable detail for the UI. */
  detail?: string;
  error?: string;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: string[] }>;
}

// ---------------------------------------------------------------------------
// LocalCRM — SQLite-backed fallback when the Twenty Docker stack is absent.
//
// Provides basic CRM entities (contacts, companies, deals) with a minimal
// GraphQL query/mutation parser so the same API surface works whether the
// server is the full Twenty stack or the local SQLite file.
// ---------------------------------------------------------------------------

/** Minimal column metadata for each CRM entity → table mapping. */
const ENTITY_COLUMNS: Record<string, string[]> = {
  contacts: ['id', 'name', 'email', 'phone', 'company_id', 'position', 'created_at', 'updated_at'],
  companies: ['id', 'name', 'domain', 'industry', 'created_at', 'updated_at'],
  deals: ['id', 'name', 'amount', 'stage', 'contact_id', 'company_id', 'created_at', 'updated_at'],
};

export class LocalCRM {
  private db: Database.Database;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.join(dataDir, 'twenty-local.db');
    fs.mkdirSync(path.dirname(this.dataDir), { recursive: true });
    this.db = new Database(this.dataDir);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  /** Whether the local CRM database is accessible. */
  get available(): boolean {
    return true;
  }

  get dbPath(): string {
    return this.dataDir;
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company_id TEXT,
        position TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        industry TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);

      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        amount REAL DEFAULT 0,
        stage TEXT DEFAULT 'lead',
        contact_id TEXT,
        company_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
    `);
    getLogger().info({ dbPath: this.dataDir }, 'LocalCRM: SQLite fallback CRM initialized');
  }

  /** Minimal GraphQL → SQL executor. Supports basic queries and mutations
   *  for contacts, companies, and deals. Returns a result shaped like a
   *  standard GraphQL response. */
  graphql(query: string, variables?: Record<string, unknown>): GraphQLResult {
    const trimmed = query.trim();
    const isMutation = /^\s*(mutation|mutation\s*\w*)\b/.test(trimmed);

    try {
      if (isMutation) return this.executeMutation(trimmed, variables);
      return this.executeQuery(trimmed);
    } catch (err: any) {
      return {
        data: null,
        errors: [{ message: `LocalCRM error: ${err.message}`, path: [] }],
      };
    }
  }

  /** Parse a simple query like `{ contacts { id name email } }` or with a filter. */
  private executeQuery(query: string): GraphQLResult {
    // Strip "query Name {" prefix if present, and extract the body.
    const bodyMatch = query.match(/(?:\w+\s*\([^)]*\)\s*)?\{(.*)\}$/s);
    if (!bodyMatch) {
      return { errors: [{ message: 'Could not parse GraphQL query', path: [] }] };
    }

    const body = bodyMatch[1].trim();

    // Match: entityName { fields }  or  entityName(filter: ...) { fields }
    // Handle nested selections minimally — we only support one level.
    const listMatch = body.match(/^(\w+)\s*(\{)/);
    if (!listMatch) {
      return { errors: [{ message: 'Could not parse GraphQL query — expected an entity', path: [] }] };
    }

    const entity = listMatch[1].toLowerCase();
    const columns = entity === 'contact' ? ENTITY_COLUMNS['contacts']
      : entity === 'company' ? ENTITY_COLUMNS['companies']
        : entity === 'deal' ? ENTITY_COLUMNS['deals']
          : ENTITY_COLUMNS[entity];

    if (!columns) {
      return { errors: [{ message: `LocalCRM does not support entity "${entity}" — install the full Twenty Docker stack`, path: [entity] }] };
    }

    // Extract requested fields between the first { after entity and its closing }
    const fields = this.extractFields(body, entity);
    const selectCols = fields.filter(f => columns.includes(f));
    if (selectCols.length === 0) {
      return { errors: [{ message: `No valid fields for ${entity}`, path: [entity] }] };
    }

    const sql = `SELECT ${selectCols.map(c => `"${c}"`).join(', ')} FROM "${entity === 'contact' ? 'contacts' : entity === 'company' ? 'companies' : entity === 'deal' ? 'deals' : entity}"`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];
    const resultKey = entity.endsWith('s') ? entity : entity + 's';
    return { data: { [resultKey]: rows } };
  }

  /** Extract field names from a selection set, handling `{ id name email }`. */
  private extractFields(body: string, entity: string): string[] {
    // Find the opening brace after the entity name
    const entityIdx = body.indexOf(entity);
    if (entityIdx === -1) return [];
    const afterEntity = body.slice(entityIdx + entity.length);
    const braceStart = afterEntity.indexOf('{');
    if (braceStart === -1) return [];

    // Find matching closing brace
    let depth = 1;
    let i = braceStart + 1;
    while (i < afterEntity.length && depth > 0) {
      if (afterEntity[i] === '{') depth++;
      else if (afterEntity[i] === '}') depth--;
      i++;
    }

    const selection = afterEntity.slice(braceStart + 1, i - 1).trim();
    // Split by whitespace, filter out nested (lines with braces)
    return selection
      .split(/\s+/)
      .map(f => f.trim())
      .filter(f => f && !f.includes('{') && !f.includes('}'));
  }

  /** Parse a minimal mutation: `mutation { createContact(input: {...}) { fields } }` */
  private executeMutation(query: string, _variables?: Record<string, unknown>): GraphQLResult {
    const mutationMatch = query.match(/\{\s*(\w+)\s*\(\s*input\s*:\s*\{([\s\S]*?)\s*\}\s*\)\s*\{([\s\S]*?)\}/);
    if (!mutationMatch) {
      return { errors: [{ message: 'Could not parse GraphQL mutation', path: [] }] };
    }

    const op = mutationMatch[1]; // e.g. createContact, updateContact, deleteContact
    const inputRaw = mutationMatch[2];
    const returnFields = mutationMatch[3].trim();

    const parts = op.split(/(?=[A-Z])/); // ['create', 'Contact']
    const verb = parts[0]?.toLowerCase() || '';
    const entityName = (parts[1] || '').toLowerCase();
    const tableName = entityName.endsWith('s') ? entityName : entityName + 's';
    const cols = ENTITY_COLUMNS[tableName];

    if (!cols) {
      return { errors: [{ message: `LocalCRM does not support mutation "${op}"`, path: [op] }] };
    }

    if (verb === 'create') {
      const id = crypto.randomUUID();
      const input = this.parseInput(inputRaw);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const inputCols = Object.keys(input).filter(c => cols.includes(c) || c === 'id');
      const vals = inputCols.map(c => input[c]);
      const placeholders = vals.map(() => '?').join(', ');
      const colList = inputCols.map(c => `"${c}"`).join(', ');

      const stmt = this.db.prepare(`INSERT INTO "${tableName}" (${colList}, "created_at", "updated_at") VALUES (${placeholders}, ?, ?)`);
      stmt.run(...vals, now, now);

      const returnCols = returnFields.split(/\s+/).map(f => f.trim()).filter(f => cols.includes(f));
      if (returnCols.length === 0) {
        return { data: { [op]: { id } } };
      }
      const row = this.db.prepare(`SELECT ${returnCols.map(c => `"${c}"`).join(', ')} FROM "${tableName}" WHERE id = ?`).get(id) as Record<string, unknown>;
      return { data: { [op]: { ...row, id } } };
    }

    if (verb === 'update') {
      // updateContact(id: "...", input: {...}) → we treat the first arg as id
      // For simplicity, parse id from the input block if present
      const idMatch = query.match(/id\s*:\s*"([^"]+)"/);
      const id = idMatch ? idMatch[1] : '';
      if (!id) {
        return { errors: [{ message: 'updateContact requires an id', path: [op] }] };
      }
      const input = this.parseInput(inputRaw);
      const setCols = Object.keys(input).filter(c => cols.includes(c) && c !== 'id');
      if (setCols.length === 0) {
        return { errors: [{ message: 'No fields to update', path: [op] }] };
      }
      const setClause = setCols.map(c => `"${c}" = ?`).join(', ');
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const stmt = this.db.prepare(`UPDATE "${tableName}" SET ${setClause}, "updated_at" = ? WHERE id = ?`);
      stmt.run(...setCols.map(c => input[c]), now, id);

      const returnCols = returnFields.split(/\s+/).map(f => f.trim()).filter(f => cols.includes(f));
      if (returnCols.length === 0) return { data: { [op]: { id } } };
      const row = this.db.prepare(`SELECT ${returnCols.map(c => `"${c}"`).join(', ')} FROM "${tableName}" WHERE id = ?`).get(id) as Record<string, unknown>;
      return { data: { [op]: { ...row, id } } };
    }

    if (verb === 'delete') {
      const idMatch = query.match(/id\s*:\s*"([^"]+)"/);
      const id = idMatch ? idMatch[1] : '';
      if (!id) {
        return { errors: [{ message: 'deleteContact requires an id', path: [op] }] };
      }
      const stmt = this.db.prepare(`DELETE FROM "${tableName}" WHERE id = ?`);
      stmt.run(id);
      return { data: { [op]: { id, success: true } } };
    }

    return { errors: [{ message: `LocalCRM does not support mutation verb "${verb}"`, path: [op] }] };
  }

  /** Parse a simple GraphQL input block: { name: "value", email: "x@y" } */
  private parseInput(raw: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const pairRegex = /(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|(\d+\.?\d*)|(\w+))/g;
    let m: RegExpExecArray | null;
    while ((m = pairRegex.exec(raw)) !== null) {
      const key = m[1];
      const val = m[2] ?? m[3] ?? (m[4] ? parseFloat(m[4]) : (m[5] ?? null));
      result[key] = val;
    }
    return result;
  }

  /** Convenience: run a raw SQL query. */
  query(sql: string, params?: unknown[]): unknown[] {
    const stmt = this.db.prepare(sql);
    return params ? stmt.all(...params) : stmt.all();
  }
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
  /** Local SQLite CRM fallback — created lazily when Twenty Docker is absent. */
  private localCRM: LocalCRM | null = null;

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

  /** True when the Twenty Docker compose file is present on disk. */
  isAvailable(): boolean {
    return fs.existsSync(this.composeFile);
  }

  /** Convenience alias — true when either the Docker stack is present OR the
   *  local SQLite fallback is initialized. */
  get available(): boolean {
    return this.isAvailable() || this.localCRM !== null;
  }

  /** True when either the Docker stack is running or the local CRM is active. */
  isRunning(): boolean {
    return this.startedAt > 0 || this.localCRM !== null;
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

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Start Twenty. When the Docker compose file is present, start the full
   * Twenty stack. When it is absent, gracefully fall back to the local
   * SQLite-backed CRM so CRM features still work (basic contact/company/deal
   * CRUD) without Docker.
   *
   * Never throws — callers can check `getStatus().local` to see which mode
   * is active.
   */
  async start(): Promise<TwentyStatus> {
    if (this.localCRM) {
      return { running: true, url: '', healthy: true, local: true, detail: 'Local SQLite CRM' };
    }

    if (!this.isAvailable()) {
      getLogger().warn(
        `Twenty CRM Docker stack not found in ${this.dockerDir} — ` +
          'using local SQLite-backed CRM fallback. ' +
          'Install with: cd backend && git clone https://github.com/twentyhq/twenty.git external/twenty',
      );
      this.localCRM = new LocalCRM(this.dataDir);
      return { running: true, url: '', healthy: true, local: true, detail: 'Local SQLite CRM' };
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
      getLogger().error({ err: err.message }, 'Twenty CRM failed to start — falling back to local CRM');
      this.localCRM = new LocalCRM(this.dataDir);
      return { running: true, url: '', healthy: true, local: true, detail: 'Local SQLite CRM (Docker failed)' };
    }

    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (this.localCRM) {
      this.localCRM = null;
      getLogger().info('LocalCRM: stopped');
      return;
    }
    if (!this.isRunning()) return;
    try {
      await this.compose(['down']);
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Twenty CRM stop had errors');
    }
    this.startedAt = 0;
  }

  async getStatus(): Promise<TwentyStatus> {
    if (this.localCRM) {
      return {
        running: true,
        url: this.localCRM.dbPath,
        healthy: true,
        local: true,
        detail: 'Local SQLite CRM fallback',
        uptimeMs: undefined,
      };
    }
    const healthy = await this.healthCheck();
    return {
      running: this.isRunning(),
      url: this.config.serverUrl,
      healthy,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : undefined,
    };
  }

  // ── GraphQL ────────────────────────────────────────────────

  /**
   * Execute a GraphQL query. When the Twenty Docker stack is not running,
   * delegates to the local SQLite CRM (basic contacts/companies/deals).
   */
  async graphql(query: string, variables?: Record<string, unknown>): Promise<GraphQLResult> {
    if (this.localCRM) {
      return this.localCRM.graphql(query, variables);
    }

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

  private async healthCheck(): Promise<boolean> {
    try {
      const text = await this.httpGet('/healthz');
      return text.includes('ok') || text.includes('healthy');
    } catch {
      return false;
    }
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
