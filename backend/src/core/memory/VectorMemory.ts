import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../Logger';

export type EmbedFn = (text: string) => Promise<number[]>;

export interface UserActivity {
  id?: number;
  appName: string;
  windowTitle: string;
  action: string;
  targetUrl?: string;
  targetFile?: string;
  targetPath?: string;
  contextTags: string;
  durationSec: number;
  keystrokeCount: number;
  clickCount: number;
  scrollCount: number;
  isActive: boolean;
  sessionId: string;
  hourOfDay: number;
  dayOfWeek: number;
  createdAt: Date;
}

export interface PatternSummary {
  patternId?: number;
  patternType: string;
  patternJson: string;
  frequency: number;
  confidence: number;
  lastSeen: Date;
  suggestedKeyword?: string;
  knowledgeNodeId?: string;
  createdAt: Date;
}

export interface MacroDefinition {
  macroId?: number;
  triggerKeyword: string;
  detectedPattern: string;
  steps: MacroStep[];
  executionCount: number;
  createdAt: Date;
}

export interface MacroStep {
  action: string;
  params: Record<string, unknown>;
  description: string;
}

export interface ActivityLog {
  id?: number;
  taskId: string;
  description: string;
  status: string;
  stepsCount: number;
  durationMs?: number;
  createdAt: Date;
}

export interface SimilarResult {
  id: number;
  kind: string;
  refId: string;
  text: string;
  distance: number;
  createdAt: Date;
}

export interface VectorMemoryOptions {
  embed?: EmbedFn | null;
  enableVec?: boolean;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function textFallbackScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q || !t) return 0.5;
  if (t.includes(q)) return 0.9;
  const qWords = q.split(/\s+/);
  const matches = qWords.filter(w => w.length > 2 && t.includes(w)).length;
  return qWords.length === 0 ? 0.5 : 0.5 + 0.4 * (matches / qWords.length);
}

export class VectorMemory {
  private db!: Database.Database;
  private dbPath: string;
  private embed: EmbedFn | null;
  private vecAvailable: boolean = false;
  private vecTableDim: number | null = null;
  private knnStmts = new Map<string, Database.Statement>();
  private insertVecStmt: Database.Statement | null = null;

  constructor(dbPath: string, options: VectorMemoryOptions = {}) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.embed = options.embed || null;
    this.vecAvailable = options.enableVec !== false;
  }

  setEmbedder(embed: EmbedFn | null): void {
    this.embed = embed;
  }

  initialize(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        steps_count INTEGER DEFAULT 0,
        duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_activity_logs_time ON activity_logs(created_at DESC);
      CREATE TABLE IF NOT EXISTS user_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL,
        window_title TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT 'focus',
        target_url TEXT,
        target_file TEXT,
        target_path TEXT,
        context_tags TEXT DEFAULT '',
        duration_sec INTEGER DEFAULT 0,
        keystroke_count INTEGER DEFAULT 0,
        click_count INTEGER DEFAULT 0,
        scroll_count INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        session_id TEXT NOT NULL,
        hour_of_day INTEGER,
        day_of_week INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ua_app ON user_activity(app_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ua_session ON user_activity(session_id);
      CREATE INDEX IF NOT EXISTS idx_ua_time ON user_activity(created_at DESC);
      CREATE TABLE IF NOT EXISTS screen_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL DEFAULT 'screen',
        window_title TEXT DEFAULT '',
        target_url TEXT,
        filtered_text TEXT NOT NULL,
        raw_text_hash TEXT,
        context_tags TEXT DEFAULT '',
        privacy_blocks INTEGER DEFAULT 0,
        session_id TEXT,
        hour_of_day INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ss_time ON screen_snapshots(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ss_hour ON screen_snapshots(hour_of_day, created_at);
      CREATE TABLE IF NOT EXISTS pattern_summaries (
        pattern_id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_type TEXT NOT NULL,
        pattern_json TEXT NOT NULL,
        frequency INTEGER DEFAULT 1,
        confidence REAL DEFAULT 0.5,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        suggested_keyword TEXT,
        knowledge_node_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ps_type ON pattern_summaries(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_ps_freq ON pattern_summaries(frequency DESC);
      CREATE TABLE IF NOT EXISTS auto_macros (
        macro_id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_keyword TEXT UNIQUE NOT NULL,
        detected_pattern_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        execution_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_am_keyword ON auto_macros(trigger_keyword);
      CREATE TABLE IF NOT EXISTS task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        plan_json TEXT,
        result_json TEXT,
        status TEXT NOT NULL,
        total_time_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        app_count INTEGER DEFAULT 0,
        total_duration_sec INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        embedding BLOB,
        dim INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_vec_kind ON vectors(kind, ref_id);
      CREATE TABLE IF NOT EXISTS chrome_logins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        provider TEXT,
        has_password INTEGER DEFAULT 0,
        session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_chrome_logins_time ON chrome_logins(created_at DESC);
      CREATE TABLE IF NOT EXISTS chrome_cookies (
        domain TEXT NOT NULL,
        name TEXT NOT NULL,
        has_value INTEGER DEFAULT 0,
        secure INTEGER DEFAULT 0,
        http_only INTEGER DEFAULT 0,
        same_site TEXT,
        path TEXT,
        expires INTEGER,
        session INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (domain, name)
      );
      CREATE TABLE IF NOT EXISTS chrome_sites (
        url TEXT PRIMARY KEY,
        title TEXT,
        visit_count INTEGER DEFAULT 1,
        last_visit_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_chrome_sites_visit ON chrome_sites(last_visit_time DESC);
     `);

    if (this.vecAvailable) this.tryLoadVec();
    getLogger().info(
      this.vecAvailable ? 'Vector memory initialized (sqlite-vec)' : 'Vector memory initialized (fallback index)',
    );
  }

  private tryLoadVec(): void {
    try {
      const vec = require('sqlite-vec');
      const loadable = vec.getLoadablePath();
      this.db.loadExtension(loadable);
      this.db.exec('SELECT vec_version()');
      this.vecAvailable = true;
    } catch (e) {
      this.vecAvailable = false;
      getLogger().warn({ err: (e as Error).message }, 'sqlite-vec extension unavailable — using brute-force fallback');
    }
  }

  /** Read the dimension of an existing vec_items table, or null if absent. */
  private probeVecDim(): number | null {
    try {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_items'").get() as any;
      if (!row || typeof row.sql !== 'string') return null;
      const m = /float\[(\d+)\]/.exec(row.sql);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  private ensureVecTable(dim: number): void {
    if (this.vecTableDim === dim) return;
    // After a restart vecTableDim is unknown — reuse the persisted table when
    // its dimension already matches (never drop stored embeddings just
    // because we forgot the dim). Only rebuild when the embedder's dimension
    // genuinely changed (e.g. a different embedding model was configured).
    const existing = this.probeVecDim();
    if (existing !== null && existing === dim) {
      this.vecTableDim = dim;
      this.knnStmts.clear();
      this.insertVecStmt = null;
      return;
    }
    if (existing !== null) {
      getLogger().warn({ from: existing, to: dim }, 'Embedding dimension changed — rebuilding vector index');
    }
    this.db.exec('DROP TABLE IF EXISTS vec_items');
    this.db.exec(`CREATE VIRTUAL TABLE vec_items USING vec0(id INTEGER PRIMARY KEY, embedding float[${dim}])`);
    this.vecTableDim = dim;
    this.knnStmts.clear();
    this.insertVecStmt = null;
  }

  private getKnnStmt(kind: string | undefined, dim: number, k: number): Database.Statement {
    const key = `${kind || '*'}:${dim}:${k}`;
    let stmt = this.knnStmts.get(key);
    if (!stmt) {
      const where = kind ? 'WHERE v.kind = ? AND ' : 'WHERE ';
      const sql = `SELECT v.id, v.kind, v.ref_id, v.text, v.created_at, vi.distance
        FROM vec_items vi JOIN vectors v ON v.id = vi.id
        ${where} vi.embedding MATCH ? AND k = ${k} ORDER BY vi.distance ASC`;
      stmt = this.db.prepare(sql);
      this.knnStmts.set(key, stmt);
    }
    return stmt;
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    if (!this.embed) return null;
    try {
      return await this.embed(text);
    } catch {
      return null;
    }
  }

  private encodeFloat32(values: number[]): Buffer {
    const buf = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) buf.writeFloatLE(values[i], i * 4);
    return buf;
  }

  private decodeFloat32(buf: Buffer): number[] {
    const out: number[] = Array.from({ length: Math.floor(buf.length / 4) });
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  }

  async addVector(kind: string, refId: string, text: string, embedding?: number[]): Promise<number> {
    let emb: number[] | null = embedding || null;
    if (!emb) emb = await this.getEmbedding(text);
    const dim = emb ? emb.length : 0;
    const info = this.db
      .prepare('INSERT INTO vectors (kind, ref_id, text, embedding, dim) VALUES (?, ?, ?, ?, ?)')
      .run(kind, refId, text, emb ? this.encodeFloat32(emb) : null, dim);
    const id = Number(info.lastInsertRowid);
    if (emb && this.vecAvailable) {
      try {
        this.ensureVecTable(emb.length);
        this.db
          .prepare('INSERT OR REPLACE INTO vec_items (id, embedding) VALUES (?, ?)')
          .run(BigInt(id), JSON.stringify(emb));
      } catch (e) {
        this.vecAvailable = false;
        getLogger().warn({ err: (e as Error).message }, 'vec_items insert failed — dropped to fallback');
      }
    }
    return id;
  }

  async searchSimilar(
    query: string | number[],
    opts: { k?: number; kind?: string; minScore?: number } = {},
  ): Promise<SimilarResult[]> {
    const k = opts.k || 10;
    const minScore = opts.minScore ?? -1;
    let queryVec: number[] | null = null;
    if (Array.isArray(query)) queryVec = query;
    else if (this.embed) queryVec = await this.getEmbedding(query);

    if (queryVec && this.vecAvailable) {
      try {
        if (this.vecTableDim !== queryVec.length) this.ensureVecTable(queryVec.length);
        const params: unknown[] = opts.kind ? [opts.kind, JSON.stringify(queryVec)] : [JSON.stringify(queryVec)];
        const stmt = this.getKnnStmt(opts.kind, queryVec.length, k);
        const rows = stmt.all(...params) as any[];
        return rows
          .filter(r => r.distance !== undefined && r.distance !== null)
          .filter(r => 1 - r.distance >= minScore)
          .map(r => ({
            id: r.id,
            kind: r.kind,
            refId: r.ref_id,
            text: r.text,
            distance: r.distance,
            createdAt: new Date(r.created_at),
          }));
      } catch (e) {
        this.vecAvailable = false;
        getLogger().warn({ err: (e as Error).message }, 'vec KNN failed — falling back to brute force');
      }
    }

    return this.bruteForceSimilar(queryVec, opts.kind, k, minScore);
  }

  private bruteForceSimilar(queryVec: number[] | null, kind: string | undefined, k: number, minScore: number): SimilarResult[] {
    const sql = kind
      ? 'SELECT id, kind, ref_id, text, embedding, created_at FROM vectors WHERE kind = ? ORDER BY id DESC LIMIT 20000'
      : 'SELECT id, kind, ref_id, text, embedding, created_at FROM vectors ORDER BY id DESC LIMIT 20000';
    const rows = (kind ? this.db.prepare(sql).all(kind) : this.db.prepare(sql).all()) as any[];
    const scored: { row: any; dist: number }[] = [];
    for (const r of rows) {
      let dist: number;
      if (queryVec && r.embedding) {
        dist = 1 - cosineSimilarity(queryVec, this.decodeFloat32(r.embedding));
      } else {
        dist = 1 - textFallbackScore(queryVec ? '' : (r.text || ''), String(r.text || ''));
      }
      if (1 - dist >= minScore) scored.push({ row: r, dist });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, k).map(s => ({
      id: s.row.id,
      kind: s.row.kind,
      refId: s.row.ref_id,
      text: s.row.text,
      distance: s.dist,
      createdAt: new Date(s.row.created_at),
    }));
  }

  searchText(query: string, opts: { k?: number; kind?: string } = {}): SimilarResult[] {
    const k = opts.k || 10;
    const like = `%${query}%`;
    const rows = opts.kind
      ? this.db
          .prepare(
            'SELECT id, kind, ref_id, text, created_at FROM vectors WHERE kind = ? AND (text LIKE ? OR ref_id LIKE ?) ORDER BY id DESC LIMIT ?',
          )
          .all(opts.kind, like, like, k)
      : this.db
          .prepare('SELECT id, kind, ref_id, text, created_at FROM vectors WHERE text LIKE ? OR ref_id LIKE ? ORDER BY id DESC LIMIT ?')
          .all(like, like, k);
    return (rows as any[]).map(r => ({
      id: r.id,
      kind: r.kind,
      refId: r.ref_id,
      text: r.text,
      distance: 0,
      createdAt: new Date(r.created_at),
    }));
  }

  getVectorCount(kind?: string): number {
    if (kind) {
      return (this.db.prepare('SELECT COUNT(*) AS c FROM vectors WHERE kind = ?').get(kind) as any).c;
    }
    return (this.db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as any).c;
  }

  logUserActivity(activity: Omit<UserActivity, 'id' | 'createdAt'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO user_activity
          (app_name, window_title, action, target_url, target_file, target_path,
           context_tags, duration_sec, keystroke_count, click_count, scroll_count,
           is_active, session_id, hour_of_day, day_of_week)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        activity.appName,
        activity.windowTitle,
        activity.action,
        activity.targetUrl || null,
        activity.targetFile || null,
        activity.targetPath || null,
        activity.contextTags,
        activity.durationSec,
        activity.keystrokeCount,
        activity.clickCount,
        activity.scrollCount,
        activity.isActive ? 1 : 0,
        activity.sessionId,
        activity.hourOfDay,
        activity.dayOfWeek,
      );
    return Number(info.lastInsertRowid);
  }

  getUserActivity(options: { since?: Date; appName?: string; limit?: number; sessionId?: string } = {}): UserActivity[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since.toISOString());
    }
    if (options.appName) {
      conditions.push('app_name = ?');
      params.push(options.appName);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 500;
    const rows = this.db
      .prepare(`SELECT * FROM user_activity ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map(r => ({
      id: r.id,
      appName: r.app_name,
      windowTitle: r.window_title,
      action: r.action,
      isActive: r.is_active === 1,
      createdAt: new Date(r.created_at),
      targetUrl: r.target_url,
      targetFile: r.target_file,
      targetPath: r.target_path,
      contextTags: r.context_tags,
      durationSec: r.duration_sec,
      keystrokeCount: r.keystroke_count,
      clickCount: r.click_count,
      scrollCount: r.scroll_count,
      sessionId: r.session_id,
      hourOfDay: r.hour_of_day,
      dayOfWeek: r.day_of_week,
    }));
  }

  getActivitySummary(): { totalEntries: number; uniqueApps: number; topApps: { app: string; count: number }[] } {
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM user_activity').get() as any).c;
    const uniqueApps = (this.db.prepare('SELECT COUNT(DISTINCT app_name) AS c FROM user_activity').get() as any).c;
    const topApps = this.db
      .prepare(
        'SELECT app_name AS app, COUNT(*) AS count FROM user_activity WHERE is_active = 1 GROUP BY app_name ORDER BY count DESC LIMIT 10',
      )
      .all() as any[];
    return { totalEntries: total, uniqueApps, topApps };
  }

  getUserActivityPatterns(timeWindowMinutes: number = 30): {
    appSequence: string[];
    topApps: string[];
    currentContext: string;
  } {
    const since = new Date(Date.now() - timeWindowMinutes * 60 * 1000);
    const recent = this.getUserActivity({ since, limit: 100 });
    const appOrder = recent.filter(a => a.action === 'focus').map(a => a.appName);
    const uniqueApps = [...new Set(appOrder)];
    const appCounts = new Map<string, number>();
    for (const a of recent) appCounts.set(a.appName, (appCounts.get(a.appName) || 0) + 1);
    const topApps = [...appCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([app]) => app);
    const contextTags = [
      ...new Set(
        recent
          .filter(a => a.contextTags)
          .flatMap(a => a.contextTags.split(',').map(t => t.trim()).filter(Boolean)),
      ),
    ].slice(0, 10);
    return { appSequence: uniqueApps, topApps, currentContext: contextTags.join(', ') };
  }

  startSession(sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions (session_id) VALUES (?)').run(sessionId);
  }

  endSession(sessionId: string, totalDurationSec: number, appCount: number): void {
    this.db
      .prepare(
        'UPDATE sessions SET ended_at = CURRENT_TIMESTAMP, total_duration_sec = ?, app_count = ?, is_active = 0 WHERE session_id = ?',
      )
      .run(totalDurationSec, appCount, sessionId);
  }

  getSessions(limit: number = 20): any[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  saveScreenSnapshot(data: {
    appName: string;
    windowTitle: string;
    targetUrl?: string;
    filteredText: string;
    rawTextHash?: string;
    contextTags: string;
    privacyBlocks: number;
    sessionId: string;
    screenshotPath?: string;
  }): void {
    // auto-migrate: add screenshot_path column if missing (for older DBs)
    try { this.db.exec('ALTER TABLE screen_snapshots ADD COLUMN screenshot_path TEXT'); } catch {}
    this.db
      .prepare(
        `INSERT INTO screen_snapshots
          (app_name, window_title, target_url, filtered_text, raw_text_hash,
           context_tags, privacy_blocks, session_id, hour_of_day, screenshot_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.appName,
        data.windowTitle,
        data.targetUrl || null,
        data.filteredText,
        data.rawTextHash || null,
        data.contextTags,
        data.privacyBlocks,
        data.sessionId,
        new Date().getHours(),
        data.screenshotPath || null,
      );
    // Auto-embed for semantic recall (fire-and-forget, never blocks capture)
    if (data.filteredText && data.filteredText.length > 20) {
      void this.addVector('snapshot', `${Date.now()}`, data.filteredText.slice(0, 2000)).catch(() => {});
    }
  }

  getScreenSnapshots(options: { since?: Date; until?: Date; hour?: number; limit?: number } = {}): any[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since.toISOString());
    }
    if (options.until) {
      conditions.push('created_at <= ?');
      params.push(options.until.toISOString());
    }
    if (options.hour !== undefined) {
      conditions.push('hour_of_day = ?');
      params.push(options.hour);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 100;
    const rows = this.db
      .prepare(`SELECT * FROM screen_snapshots ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map(r => ({
      id: r.id,
      appName: r.app_name,
      windowTitle: r.window_title,
      targetUrl: r.target_url,
      filteredText: r.filtered_text,
      contextTags: r.context_tags,
      privacyBlocks: r.privacy_blocks,
      createdAt: new Date(r.created_at),
    }));
  }

  getHourlySnapshots(date: Date): Map<number, { texts: string[]; apps: Set<string>; urls: Set<string>; privacyCount: number }> {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    const snapshots = this.getScreenSnapshots({ since: dayStart, until: dayEnd, limit: 5000 });
    const hourly = new Map<number, { texts: string[]; apps: Set<string>; urls: Set<string>; privacyCount: number }>();
    for (const snap of snapshots) {
      const h = new Date(snap.createdAt).getHours();
      if (!hourly.has(h)) hourly.set(h, { texts: [], apps: new Set(), urls: new Set(), privacyCount: 0 });
      const block = hourly.get(h)!;
      block.texts.push(snap.filteredText);
      block.apps.add(snap.appName);
      if (snap.targetUrl) block.urls.add(snap.targetUrl);
      block.privacyCount += snap.privacyBlocks;
    }
    return hourly;
  }

  getHourlyScreenSummary(date: Date, hour: number): string {
    const snapshots = this.getScreenSnapshots({
      since: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0),
      until: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 59, 59),
      limit: 200,
    });
    if (snapshots.length === 0) return '';
    const allTexts = snapshots.map(s => s.filteredText).filter(Boolean);
    const combined = allTexts.join('\n\n---\n\n');
    return combined.length > 10000 ? combined.substring(0, 10000) + '\n\n[...content truncated]' : combined;
  }

  savePattern(pattern: Omit<PatternSummary, 'patternId' | 'createdAt'>): void {
    const existing = this.db
      .prepare('SELECT pattern_id, frequency FROM pattern_summaries WHERE pattern_type = ? AND pattern_json = ?')
      .get(pattern.patternType, pattern.patternJson) as any;
    if (existing) {
      this.db
        .prepare(
          `UPDATE pattern_summaries SET
             frequency = frequency + 1, confidence = ?,
             last_seen = CURRENT_TIMESTAMP,
             suggested_keyword = COALESCE(?, suggested_keyword),
             knowledge_node_id = COALESCE(?, knowledge_node_id)
           WHERE pattern_id = ?`,
        )
        .run(
          pattern.confidence,
          pattern.suggestedKeyword || null,
          pattern.knowledgeNodeId || null,
          existing.pattern_id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO pattern_summaries
            (pattern_type, pattern_json, frequency, confidence, suggested_keyword, knowledge_node_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pattern.patternType,
          pattern.patternJson,
          1,
          pattern.confidence,
          pattern.suggestedKeyword || null,
          pattern.knowledgeNodeId || null,
        );
    }
  }

  getHighConfidencePatterns(minFrequency: number = 3): PatternSummary[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM pattern_summaries WHERE frequency >= ? ORDER BY frequency DESC, confidence DESC',
      )
      .all(minFrequency) as any[];
    return rows.map(r => ({
      patternId: r.pattern_id,
      patternType: r.pattern_type,
      patternJson: r.pattern_json,
      frequency: r.frequency,
      confidence: r.confidence,
      lastSeen: new Date(r.last_seen),
      suggestedKeyword: r.suggested_keyword,
      knowledgeNodeId: r.knowledge_node_id,
      createdAt: new Date(r.created_at),
    }));
  }

  linkPatternToKnowledge(patternId: number, nodeId: string): void {
    this.db
      .prepare('UPDATE pattern_summaries SET knowledge_node_id = ? WHERE pattern_id = ?')
      .run(nodeId, patternId);
  }

  logActivity(taskId: string, description: string, status: string, stepsCount: number): void {
    this.db
      .prepare(
        'INSERT INTO activity_logs (task_id, description, status, steps_count) VALUES (?, ?, ?, ?)',
      )
      .run(taskId, description, status, stepsCount);
  }

  getRecentActivity(limit: number = 50): ActivityLog[] {
    const rows = this.db
      .prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as any[];
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      description: r.description,
      status: r.status,
      stepsCount: r.steps_count,
      durationMs: r.duration_ms,
      createdAt: new Date(r.created_at),
    }));
  }

  findPatterns(windowSize: number = 5): Map<string, number> {
    const logs = this.getRecentActivity(1000);
    const patternCounts = new Map<string, number>();
    for (let i = 0; i <= logs.length - windowSize; i++) {
      const window = logs.slice(i, i + windowSize);
      const pattern = window
        .map(l => {
          const d = l.description.toLowerCase();
          if (d.includes('navigate') || d.includes('go to')) return 'navigate';
          if (d.includes('click') || d.includes('tap')) return 'click';
          if (d.includes('type') || d.includes('enter')) return 'type';
          if (d.includes('scroll')) return 'scroll';
          if (d.includes('extract') || d.includes('read')) return 'extract';
          return d.substring(0, 20);
        })
        .join(' -> ');
      patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
    }
    return patternCounts;
  }

  saveMacro(macro: Omit<MacroDefinition, 'macroId' | 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO auto_macros (trigger_keyword, detected_pattern_json, steps_json, execution_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(trigger_keyword) DO UPDATE SET
           execution_count = execution_count + 1, steps_json = excluded.steps_json`,
      )
      .run(
        macro.triggerKeyword,
        JSON.stringify(macro.detectedPattern),
        JSON.stringify(macro.steps),
        macro.executionCount,
      );
  }

  getMacro(keyword: string): MacroDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM auto_macros WHERE trigger_keyword = ?').get(keyword) as any;
    if (!row) return undefined;
    return {
      macroId: row.macro_id,
      triggerKeyword: row.trigger_keyword,
      detectedPattern: row.detected_pattern_json,
      steps: JSON.parse(row.steps_json || '[]'),
      executionCount: row.execution_count,
      createdAt: new Date(row.created_at),
    };
  }

  getAllMacros(): MacroDefinition[] {
    const rows = this.db.prepare('SELECT * FROM auto_macros ORDER BY execution_count DESC').all() as any[];
    return rows.map((r: any) => ({
      macroId: r.macro_id,
      triggerKeyword: r.trigger_keyword,
      detectedPattern: r.detected_pattern_json,
      steps: JSON.parse(r.steps_json || '[]'),
      executionCount: r.execution_count,
      createdAt: new Date(r.created_at),
    }));
  }

  saveTaskHistory(taskId: string, description: string, plan: any, result: any, status: string, totalTimeMs: number): void {
    this.db
      .prepare(
        `INSERT INTO task_history (task_id, description, plan_json, result_json, status, total_time_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           status = excluded.status, result_json = excluded.result_json, total_time_ms = excluded.total_time_ms`,
      )
      .run(
        taskId,
        description,
        JSON.stringify(plan),
        JSON.stringify(result),
        status,
        totalTimeMs,
      );
  }

  /** Persist a fact the user told the assistant about themselves. */
  rememberFact(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('fact text is required');
    const info = this.db.prepare('INSERT INTO user_facts (text) VALUES (?)').run(trimmed);
    return Number(info.lastInsertRowid);
  }

  getFacts(limit: number = 50): { id: number; text: string; createdAt: Date }[] {
    const rows = this.db.prepare('SELECT * FROM user_facts ORDER BY id DESC LIMIT ?').all(limit) as any[];
    return rows.map(r => ({ id: r.id, text: r.text, createdAt: new Date(r.created_at) }));
  }

  saveChromeLogin(url: string, provider: string | null, hasPassword: boolean, sessionId?: string): void {
    this.db.prepare('INSERT INTO chrome_logins (url, provider, has_password, session_id) VALUES (?, ?, ?, ?)').run(url, provider || null, hasPassword ? 1 : 0, sessionId || null);
  }
  getChromeLogins(limit: number = 100): any[] {
    return this.db.prepare('SELECT * FROM chrome_logins ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
  }
  saveChromeCookie(domain: string, cookie: { name: string; hasValue?: boolean; secure?: boolean; httpOnly?: boolean; sameSite?: string; path?: string; expires?: number; session?: boolean }): void {
    this.db.prepare(`
      INSERT INTO chrome_cookies (domain, name, has_value, secure, http_only, same_site, path, expires, session, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(domain, name) DO UPDATE SET has_value=excluded.has_value, secure=excluded.secure, http_only=excluded.http_only, same_site=excluded.same_site, path=excluded.path, expires=excluded.expires, session=excluded.session, updated_at=CURRENT_TIMESTAMP
    `).run(domain, cookie.name, cookie.hasValue ? 1 : 0, cookie.secure ? 1 : 0, cookie.httpOnly ? 1 : 0, cookie.sameSite || null, cookie.path || '/', cookie.expires || null, cookie.session ? 1 : 0);
  }
  getChromeCookies(domain?: string, limit: number = 500): any[] {
    if (domain) return this.db.prepare('SELECT * FROM chrome_cookies WHERE domain = ? ORDER BY updated_at DESC LIMIT ?').all(domain, limit) as any[];
    return this.db.prepare('SELECT * FROM chrome_cookies ORDER BY updated_at DESC LIMIT ?').all(limit) as any[];
  }
  getChromeCookieDomains(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT domain FROM chrome_cookies ORDER BY domain').all() as any[];
    return rows.map(r => r.domain);
  }
  saveChromeSite(url: string, title?: string, visitCount?: number, lastVisitTime?: number): void {
    const vt = lastVisitTime ? new Date(lastVisitTime).toISOString() : new Date().toISOString();
    this.db.prepare(`
      INSERT INTO chrome_sites (url, title, visit_count, last_visit_time)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET title=COALESCE(excluded.title, chrome_sites.title), visit_count=MAX(chrome_sites.visit_count, excluded.visit_count), last_visit_time=CASE WHEN excluded.last_visit_time > chrome_sites.last_visit_time THEN excluded.last_visit_time ELSE chrome_sites.last_visit_time END
    `).run(url, title || null, visitCount || 1, vt);
  }
  getChromeSites(limit: number = 200): any[] {
    return this.db.prepare('SELECT * FROM chrome_sites ORDER BY last_visit_time DESC LIMIT ?').all(limit) as any[];
  }

  query(sql: string, params?: any[]): any[] {
    if (params && params.length > 0) return this.db.prepare(sql).all(...params) as any[];
    return this.db.prepare(sql).all() as any[];
  }

  getVecStats(): { available: boolean; vectors: number; dim: number | null } {
    return { available: this.vecAvailable, vectors: this.getVectorCount(), dim: this.vecTableDim };
  }

  // ── Memory perfect: unified query + retention ──────────────────
  async unifiedQuery(query: string, opts: { k?: number; apps?: string[]; since?: Date; kinds?: string[] } = {}): Promise<{ similar: any[]; activities: any[]; snapshots: any[]; facts: any[] }> {
    const k = opts.k || 10;
    const similar = await this.searchSimilar(query, { k, kind: undefined });
    const activities = this.getUserActivity({ since: opts.since, limit: k * 2 }).filter(a => !opts.apps || opts.apps.includes(a.appName));
    const snapshots = this.getScreenSnapshots({ since: opts.since, limit: k });
    const facts = this.getFacts(k);
    return { similar, activities, snapshots, facts };
  }

  pruneOld(days: number = 30): { deletedActivities: number; deletedSnapshots: number } {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const a = this.db.prepare('DELETE FROM user_activity WHERE created_at < ?').run(cutoff);
    const s = this.db.prepare('DELETE FROM screen_snapshots WHERE created_at < ?').run(cutoff);
    try { this.db.exec('VACUUM'); } catch {}
    return { deletedActivities: a.changes, deletedSnapshots: s.changes };
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
    }
  }
}
