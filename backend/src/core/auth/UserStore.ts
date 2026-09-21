/**
 * UserStore — lightweight SQLite-backed user accounts for the web app.
 *
 * Handles signup, login (API key auth), plan management, and device pairing.
 * No JWT sessions — the web app sends an API key on every request (simple, stateless).
 */
import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../Logger';

export interface User {
  id: string;
  email: string;
  name: string;
  plan: 'free' | 'byok' | 'pro' | 'ultimate' | 'enterprise';
  apiKey: string;
  createdAt: Date;
  lastLogin?: Date;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  type: 'desktop' | 'phone' | 'server';
  pairedAt: Date;
  lastSeen?: Date;
  publicKey?: string;
}

export interface PlanInfo {
  tier: string;
  monthlyBudget: number;
  maxDevices: number;
  cloudAccess: boolean;
  mobileApp: boolean;
}

const PLANS: Record<string, PlanInfo> = {
  free: { tier: 'free', monthlyBudget: 0, maxDevices: 0, cloudAccess: false, mobileApp: false },
  byok: { tier: 'byok', monthlyBudget: 1, maxDevices: 1, cloudAccess: true, mobileApp: false },
  pro: { tier: 'pro', monthlyBudget: 5, maxDevices: 1, cloudAccess: true, mobileApp: true },
  ultimate: { tier: 'ultimate', monthlyBudget: 10, maxDevices: 5, cloudAccess: true, mobileApp: true },
  advanced: { tier: 'ultimate', monthlyBudget: 10, maxDevices: 5, cloudAccess: true, mobileApp: true },
  enterprise: { tier: 'enterprise', monthlyBudget: 20, maxDevices: 999, cloudAccess: true, mobileApp: true },
};

export class UserStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        api_key TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'desktop',
        paired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME,
        public_key TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    `);
    // JIT infrastructure columns — safe to run on every boot (idempotent)
    this.migrateJIT();
  }

  private migrateJIT(): void {
    const cols = this.db.prepare("PRAGMA table_info(users)").all() as any[];
    const names = new Set(cols.map(c => c.name));
    if (!names.has('ai_budget_limit')) this.db.exec("ALTER TABLE users ADD COLUMN ai_budget_limit REAL DEFAULT 0");
    if (!names.has('hetzner_server_id')) this.db.exec("ALTER TABLE users ADD COLUMN hetzner_server_id INTEGER");
    if (!names.has('stripe_customer_id')) this.db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT");
    if (!names.has('stripe_subscription_id')) this.db.exec("ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT");
    if (!names.has('budget_reset_at')) this.db.exec("ALTER TABLE users ADD COLUMN budget_reset_at DATETIME");
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  signup(email: string, password: string, name: string): User | null {
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return null; // email taken

    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = this.hashPassword(password, salt);
    const apiKey = 'umbra_' + crypto.randomBytes(32).toString('hex');

    this.db.prepare(
      'INSERT INTO users (id, email, name, password_hash, salt, api_key) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, email, name, hash, salt, apiKey);

    getLogger().info({ userId: id, email }, 'User signed up');
    return this.getUserById(id)!;
  }

  login(email: string, password: string): User | null {
    const row = this.db.prepare(
      'SELECT id, password_hash, salt FROM users WHERE email = ?'
    ).get(email) as any;
    if (!row) return null;

    const hash = this.hashPassword(password, row.salt);
    if (hash !== row.password_hash) return null;

    this.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    return this.getUserById(row.id);
  }

  loginWithApiKey(apiKey: string): User | null {
    const row = this.db.prepare('SELECT id FROM users WHERE api_key = ?').get(apiKey) as any;
    if (!row) return null;
    this.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    return this.getUserById(row.id);
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare(
      'SELECT id, email, name, plan, api_key, created_at, last_login FROM users WHERE id = ?'
    ).get(id) as any;
    if (!row) return null;
    return this.rowToUser(row);
  }

  getUserByApiKey(apiKey: string): User | null {
    const row = this.db.prepare(
      'SELECT id, email, name, plan, api_key, created_at, last_login FROM users WHERE api_key = ?'
    ).get(apiKey) as any;
    if (!row) return null;
    return this.rowToUser(row);
  }

  // ── Plan ──────────────────────────────────────────────────────────────

  getPlan(userId: string): PlanInfo {
    const user = this.getUserById(userId);
    return PLANS[user?.plan || 'free'] || PLANS.free;
  }

  setPlan(userId: string, tier: string): boolean {
    // Normalize alias: advanced == ultimate
    const normalized = tier === 'advanced' ? 'ultimate' : tier;
    if (!PLANS[normalized]) return false;
    this.db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(normalized, userId);
    getLogger().info({ userId, tier: normalized }, 'Plan updated');
    return true;
  }

  // ── JIT Wallet + Hetzner ──────────────────────────────────────────

  /** Initialize virtual wallet after successful payment. */
  initWallet(userId: string, tier: string, budget: number): void {
    this.db.prepare('UPDATE users SET ai_budget_limit = ?, budget_reset_at = CURRENT_TIMESTAMP WHERE id = ?').run(budget, userId);
    this.setPlan(userId, tier);
    getLogger().info({ userId, tier, budget }, 'Virtual wallet initialized');
  }

  /** Link Hetzner server to user. */
  setHetznerServerId(userId: string, serverId: number): void {
    this.db.prepare('UPDATE users SET hetzner_server_id = ? WHERE id = ?').run(serverId, userId);
  }

  getHetznerServerId(userId: string): number | null {
    const row = this.db.prepare('SELECT hetzner_server_id FROM users WHERE id = ?').get(userId) as any;
    return row?.hetzner_server_id ?? null;
  }

  findByStripeCustomerId(customerId: string): User | null {
    const row = this.db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId) as any;
    if (!row) return null;
    return this.getUserById(row.id);
  }

  linkStripeCustomer(userId: string, customerId: string, subscriptionId?: string): void {
    this.db.prepare('UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?').run(customerId, subscriptionId || null, userId);
  }

  getWallet(userId: string): number {
    const row = this.db.prepare('SELECT ai_budget_limit FROM users WHERE id = ?').get(userId) as any;
    return row ? Number(row.ai_budget_limit || 0) : 0;
  }

  /** Deduct cost from wallet; returns remaining. Caps at 0. */
  deductWallet(userId: string, cost: number): number {
    const current = this.getWallet(userId);
    const next = Math.max(0, current - cost);
    this.db.prepare('UPDATE users SET ai_budget_limit = ? WHERE id = ?').run(next, userId);
    return next;
  }

  isWalletDepleted(userId: string): boolean {
    return this.getWallet(userId) <= 0;
  }

  /** Find user by server id for teardown */
  findByHetznerServerId(serverId: number): User | null {
    const row = this.db.prepare('SELECT id FROM users WHERE hetzner_server_id = ?').get(serverId) as any;
    if (!row) return null;
    return this.getUserById(row.id);
  }

  /** Extend User type helpers to include JIT fields */
  getUserWithJIT(id: string): (User & { ai_budget_limit: number; hetzner_server_id: number | null; stripe_customer_id: string | null }) | null {
    const row = this.db.prepare('SELECT id, email, name, plan, api_key, created_at, last_login, ai_budget_limit, hetzner_server_id, stripe_customer_id FROM users WHERE id = ?').get(id) as any;
    if (!row) return null;
    const base = this.rowToUser(row);
    return { ...base, ai_budget_limit: Number(row.ai_budget_limit || 0), hetzner_server_id: row.hetzner_server_id ?? null, stripe_customer_id: row.stripe_customer_id ?? null };
  }

  // ── Devices ───────────────────────────────────────────────────────────

  listDevices(userId: string): Device[] {
    const rows = this.db.prepare(
      'SELECT id, user_id, name, type, paired_at, last_seen, public_key FROM devices WHERE user_id = ? ORDER BY paired_at DESC'
    ).all(userId) as any[];
    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      type: r.type,
      pairedAt: new Date(r.paired_at),
      lastSeen: r.last_seen ? new Date(r.last_seen) : undefined,
      publicKey: r.public_key,
    }));
  }

  pairDevice(userId: string, name: string, type: string, publicKey?: string): Device | null {
    const plan = this.getPlan(userId);
    const devices = this.listDevices(userId);

    // Plan gate: free users can't pair devices
    if (!plan.mobileApp && type === 'phone') return null;
    if (devices.length >= plan.maxDevices && plan.maxDevices < 999) return null;

    const id = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO devices (id, user_id, name, type, public_key) VALUES (?, ?, ?, ?, ?)'
    ).run(id, userId, name, type, publicKey || null);

    getLogger().info({ userId, deviceId: id, name, type }, 'Device paired');
    return { id, userId, name, type: type as any, pairedAt: new Date(), publicKey };
  }

  removeDevice(userId: string, deviceId: string): boolean {
    const result = this.db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(deviceId, userId);
    return result.changes > 0;
  }

  updateDeviceLastSeen(deviceId: string): void {
    this.db.prepare('UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(deviceId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private hashPassword(password: string, salt: string): string {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  }

  private rowToUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      plan: row.plan,
      apiKey: row.api_key,
      createdAt: new Date(row.created_at),
      lastLogin: row.last_login ? new Date(row.last_login) : undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
