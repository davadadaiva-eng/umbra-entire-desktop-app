/**
 * Umbra OS — RecordsStore (generic owner/kind/id JSON record layer).
 *
 * Modeled on openmuse `apps/server/src/db.ts` Store over
 * `records(owner,kind,id,data)` with:
 *   get / list / put / remove
 *   compareAndSwap / insertIfAbsent / take / scan / claim
 *
 * OpenMuse uses Postgres (pg / PGlite) with jsonb operators (@>, ||,
 * jsonb_set, jsonb_build_object). Umbra runs on better-sqlite3, so the same
 * semantics are implemented on SQLite + JSON1 (TEXT data column, json_extract
 * / json_set) with synchronous better-sqlite3 wrapped in async methods to keep
 * the Store interface identical.
 *
 * This store lives ALONGSIDE the existing file-based TaskStore
 * (`src/core/agent/TaskStore.ts`) — TaskStore is NOT deleted. New durable
 * cross-owner state (drafts, conversations, actions, credentials, etc.) should
 * use RecordsStore; task-queue checkpoint files stay on TaskStore.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

// ── Types ─────────────────────────────────────────────────────────────

export interface RecordValue {
  id: string;
  [key: string]: unknown;
}

export interface ScannedRecord<T = Record<string, unknown>> {
  owner: string;
  value: T;
}

export interface IRecordsStore {
  get<T = Record<string, unknown>>(owner: string, kind: string, id: string): Promise<T | null>;
  list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]>;
  put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T>;
  remove(owner: string, kind: string, id: string): Promise<void>;
  compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null>;
  insertIfAbsent<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T | null>;
  scan<T = Record<string, unknown>>(kind: string): Promise<ScannedRecord<T>[]>;
  take<T = Record<string, unknown>>(owner: string, kind: string, id: string): Promise<T | null>;
  claim<T = Record<string, unknown>>(owner: string, id: string, status: string, now: string): Promise<T | null>;
  close(): void;
}

export interface RecordsStoreOptions {
  /** File path for the SQLite DB. Use ':memory:' for ephemeral/test stores. */
  dbPath?: string;
}

// ── SQLite implementation ─────────────────────────────────────────────

export class SqliteRecordsStore implements IRecordsStore {
  private db: Database.Database;

  constructor(options: RecordsStoreOptions = {}) {
    const dbPath = options.dbPath ?? defaultDbPath();
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner, kind, id)
      );
      CREATE INDEX IF NOT EXISTS idx_records_owner_kind ON records(owner, kind);
      CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind);
      CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at);
    `);
  }

  async get<T = Record<string, unknown>>(owner: string, kind: string, id: string): Promise<T | null> {
    const row = this.db
      .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?')
      .get(owner, kind, id) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as T;
  }

  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const rows = this.db
      .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? ORDER BY updated_at DESC, id')
      .all(owner, kind) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    const data = JSON.stringify(value);
    this.db
      .prepare(
        `INSERT INTO records (owner, kind, id, data, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(owner, kind, id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(owner, kind, value.id, data);
    return value;
  }

  async remove(owner: string, kind: string, id: string): Promise<void> {
    this.db.prepare('DELETE FROM records WHERE owner = ? AND kind = ? AND id = ?').run(owner, kind, id);
  }

  /**
   * Atomic check-and-set: only applies `patch` when every key in `expected`
   * deep-equals the stored value (mirrors Postgres `data @> expected`).
   * Returns the merged record, or null when the guard fails / row missing.
   */
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?')
        .get(owner, kind, id) as { data: string } | undefined;
      if (!row) return null;
      const current = JSON.parse(row.data) as Record<string, unknown>;
      if (!containsSubset(current, expected)) return null;
      const merged = { ...current, ...patch };
      this.db
        .prepare('UPDATE records SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ? AND kind = ? AND id = ?')
        .run(JSON.stringify(merged), owner, kind, id);
      return merged as T;
    });
    try {
      return txn() as T | null;
    } catch (err: unknown) {
      getLogger().warn({ err: (err as Error)?.message, owner, kind, id }, 'RecordsStore.compareAndSwap failed');
      return null;
    }
  }

  /**
   * Insert only when no row exists (mirrors `ON CONFLICT DO NOTHING RETURNING`).
   * Returns the inserted value, or null when a row already exists.
   */
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO records (owner, kind, id, data) VALUES (?, ?, ?, ?)')
      .run(owner, kind, value.id, JSON.stringify(value));
    if (result.changes === 0) return null;
    return value;
  }

  async scan<T = Record<string, unknown>>(kind: string): Promise<ScannedRecord<T>[]> {
    const rows = this.db
      .prepare('SELECT owner, data FROM records WHERE kind = ? ORDER BY updated_at ASC')
      .all(kind) as Array<{ owner: string; data: string }>;
    return rows.map((r) => ({ owner: r.owner, value: JSON.parse(r.data) as T }));
  }

  /**
   * Atomically delete + return a record (mirrors `DELETE ... RETURNING data`).
   */
  async take<T = Record<string, unknown>>(owner: string, kind: string, id: string): Promise<T | null> {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?')
        .get(owner, kind, id) as { data: string } | undefined;
      if (!row) return null;
      this.db.prepare('DELETE FROM records WHERE owner = ? AND kind = ? AND id = ?').run(owner, kind, id);
      return JSON.parse(row.data) as T;
    });
    return txn() as T | null;
  }

  /**
   * Claim an `actions` record out of `awaiting_review` into `status`.
   * Mirrors openmuse `claim(owner,id,status,now)`:
   *  - row must be kind='actions', status='awaiting_review', expiresAt > now
   *  - when transitioning to 'executing', the linked task (data.taskId,
   *    kind='tasks') must be missing or still running/waiting_approval.
   */
  async claim<T = Record<string, unknown>>(
    owner: string,
    id: string,
    status: string,
    now: string,
  ): Promise<T | null> {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT data FROM records WHERE owner = ? AND kind = 'actions' AND id = ?")
        .get(owner, id) as { data: string } | undefined;
      if (!row) return null;
      const action = JSON.parse(row.data) as Record<string, unknown>;
      if (action['status'] !== 'awaiting_review') return null;
      const expiresAt = action['expiresAt'];
      if (typeof expiresAt === 'string') {
        const expMs = Date.parse(expiresAt);
        const nowMs = Date.parse(now);
        if (!Number.isNaN(expMs) && !Number.isNaN(nowMs) && !(expMs > nowMs)) return null;
      }
      if (status === 'executing') {
        const taskId = action['taskId'];
        if (typeof taskId === 'string' && taskId.length > 0) {
          const taskRow = this.db
            .prepare("SELECT data FROM records WHERE owner = ? AND kind = 'tasks' AND id = ?")
            .get(owner, taskId) as { data: string } | undefined;
          if (taskRow) {
            const task = JSON.parse(taskRow.data) as Record<string, unknown>;
            const taskStatus = task['status'];
            if (taskStatus !== 'running' && taskStatus !== 'waiting_approval') return null;
          }
          // No task row => treat as orphaned claim, allow (matches openmuse
          // EXISTS guard which passes when the task row is absent? No — the
          // openmuse guard requires taskId IS NULL OR EXISTS(running...).
          // An absent task row fails the EXISTS check, so deny. Keep parity:
          // deny when taskId is set but the task row is gone.
          if (!taskRow) return null;
        }
      }
      const updated = { ...action, status };
      this.db
        .prepare('UPDATE records SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ? AND kind = ? AND id = ?')
        .run(JSON.stringify(updated), owner, 'actions', id);
      return updated as T;
    });
    try {
      return txn() as T | null;
    } catch (err: unknown) {
      getLogger().warn({ err: (err as Error)?.message, owner, id }, 'RecordsStore.claim failed');
      return null;
    }
  }

  /**
   * Reset rows stuck in `executing` (e.g. after a crash) to `outcome_unknown`.
   * Mirrors openmuse `recoverInterruptedActions()`.
   */
  async recoverInterruptedActions(): Promise<void> {
    const rows = this.db
      .prepare("SELECT owner, id, data FROM records WHERE kind = 'actions'")
      .all() as Array<{ owner: string; id: string; data: string }>;
    const stmt = this.db.prepare(
      'UPDATE records SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ? AND kind = ? AND id = ?',
    );
    const txn = this.db.transaction(() => {
      for (const r of rows) {
        try {
          const data = JSON.parse(r.data) as Record<string, unknown>;
          if (data['status'] === 'executing') {
            const patched = {
              ...data,
              status: 'outcome_unknown',
              error: 'Server restarted during execution. Check the provider before creating another action.',
            };
            stmt.run(JSON.stringify(patched), r.owner, 'actions', r.id);
          }
        } catch {
          // Skip corrupt rows.
        }
      }
    });
    txn();
  }

  /**
   * Credential helper mirroring openmuse `updateCredential(owner,connectionId,secret)`.
   * Returns true when exactly one row was updated.
   */
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT data FROM records WHERE owner = ? AND kind = 'credentials' AND id = 'google'")
      .get(owner) as { data: string } | undefined;
    if (!row) return false;
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      if (data['connectionId'] !== connectionId) return false;
      const updated = { ...data, secret };
      const result = this.db
        .prepare("UPDATE records SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE owner = ? AND kind = 'credentials' AND id = 'google'")
        .run(JSON.stringify(updated), owner);
      return result.changes === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createRecordsStore(options: RecordsStoreOptions = {}): SqliteRecordsStore {
  return new SqliteRecordsStore(options);
}

/** Backwards-compatible alias (mirrors openmuse `Store` naming). */
export type RecordsStore = SqliteRecordsStore;

function defaultDbPath(): string {
  const base = process.env['UMBRA_DATA_DIR'] || process.env['USERPROFILE'] || process.cwd();
  return path.join(base, '.umbra', 'records.db');
}

/** Deep-subset check: every key in `expected` deep-equals `current[key]`. */
function containsSubset(current: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, expVal] of Object.entries(expected)) {
    const curVal = current[key];
    if (JSON.stringify(curVal) !== JSON.stringify(expVal)) return false;
  }
  return true;
}
