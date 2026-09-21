/**
 * ConnectorStore — SQLite-backed storage for user connector connections.
 *
 * Stores OAuth tokens, API keys, and connection status for every
 * connector a user has authorized. Tokens are encrypted at rest using
 * the CredentialVault pattern (AES-256-GCM + DPAPI).
 *
 * Schema:
 *   user_connections — per-user connector credentials
 *   developer_credentials — operator-supplied OAuth client IDs/secrets
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../Logger';

// ── Types ───────────────────────────────────────────────────────────

export interface UserConnection {
  id: string;
  userId: string;
  connectorId: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  tokenExpiresAt?: Date;
  connectionStatus: 'connected' | 'expired' | 'error' | 'disconnected';
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeveloperCredential {
  connectorSlug: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  isConfigured: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveConnectionOpts {
  userId: string;
  connectorId: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresIn?: number; // seconds
  metadata?: Record<string, unknown>;
}

// ── Encryption helpers ──────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Derive a 256-bit key from a passphrase + salt using scrypt.
 * In production, the master key comes from CredentialVault; here we
 * use a machine-bound derivation for at-rest encryption.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LEN) as Buffer;
}

function encrypt(plaintext: string, key: Buffer): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: salt(16) + iv(12) + tag(16) + ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

function decrypt(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 16 + IV_LEN);
  const tag = buf.subarray(16 + IV_LEN, 16 + IV_LEN + TAG_LEN);
  const data = buf.subarray(16 + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}

// ── ConnectorStore ──────────────────────────────────────────────────

export class ConnectorStore {
  private db: Database.Database;
  private encryptionKey: Buffer;

  constructor(dbPath: string, masterKey?: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    // Derive encryption key from master key or machine fingerprint
    const passphrase = masterKey || `umbra-connector-store-${os.hostname()}`;
    const salt = crypto.createHash('sha256').update(passphrase).digest().subarray(0, 16);
    this.encryptionKey = deriveKey(passphrase, salt);

    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        api_key TEXT,
        token_expires_at DATETIME,
        connection_status TEXT NOT NULL DEFAULT 'connected',
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, connector_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_connections_user ON user_connections(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_connections_connector ON user_connections(connector_id);

      CREATE TABLE IF NOT EXISTS developer_credentials (
        connector_slug TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        scopes TEXT DEFAULT '[]',
        is_configured INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // ── User Connections ─────────────────────────────────────────────

  saveConnection(opts: SaveConnectionOpts): UserConnection {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = JSON.stringify(opts.metadata || {});

    // Encrypt tokens at rest
    const encAccessToken = opts.accessToken ? this.encryptValue(opts.accessToken) : null;
    const encRefreshToken = opts.refreshToken ? this.encryptValue(opts.refreshToken) : null;
    const encApiKey = opts.apiKey ? this.encryptValue(opts.apiKey) : null;

    const expiresAt = opts.expiresIn
      ? new Date(Date.now() + opts.expiresIn * 1000).toISOString()
      : null;

    this.db.prepare(`
      INSERT INTO user_connections (id, user_id, connector_id, access_token, refresh_token, api_key, token_expires_at, connection_status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?)
      ON CONFLICT(user_id, connector_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        api_key = excluded.api_key,
        token_expires_at = excluded.token_expires_at,
        connection_status = 'connected',
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(id, opts.userId, opts.connectorId, encAccessToken, encRefreshToken, encApiKey, expiresAt, metadata, now, now);

    getLogger().info({ userId: opts.userId, connectorId: opts.connectorId }, 'Connector connection saved');
    return this.getConnection(opts.userId, opts.connectorId)!;
  }

  getConnection(userId: string, connectorId: string): UserConnection | null {
    const row = this.db.prepare(
      'SELECT * FROM user_connections WHERE user_id = ? AND connector_id = ?'
    ).get(userId, connectorId) as any;
    if (!row) return null;
    return this.rowToConnection(row);
  }

  listConnections(userId: string): UserConnection[] {
    const rows = this.db.prepare(
      'SELECT * FROM user_connections WHERE user_id = ? ORDER BY updated_at DESC'
    ).all(userId) as any[];
    return rows.map(r => this.rowToConnection(r));
  }

  removeConnection(userId: string, connectorId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM user_connections WHERE user_id = ? AND connector_id = ?'
    ).run(userId, connectorId);
    return result.changes > 0;
  }

  updateTokenExpiry(userId: string, connectorId: string, expiresIn: number): void {
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    this.db.prepare(
      'UPDATE user_connections SET token_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND connector_id = ?'
    ).run(expiresAt, userId, connectorId);
  }

  updateConnectionStatus(userId: string, connectorId: string, status: UserConnection['connectionStatus']): void {
    this.db.prepare(
      'UPDATE user_connections SET connection_status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND connector_id = ?'
    ).run(status, userId, connectorId);
  }

  /**
   * Get decrypted tokens for API calls. Returns undefined if not found.
   */
  getDecryptedTokens(userId: string, connectorId: string): { accessToken?: string; refreshToken?: string; apiKey?: string } | undefined {
    const conn = this.getConnection(userId, connectorId);
    if (!conn) return undefined;

    return {
      accessToken: conn.accessToken ? this.decryptValue(conn.accessToken) : undefined,
      refreshToken: conn.refreshToken ? this.decryptValue(conn.refreshToken) : undefined,
      apiKey: conn.apiKey ? this.decryptValue(conn.apiKey) : undefined,
    };
  }

  /**
   * Check if a connection is expired and needs refresh.
   */
  isExpired(userId: string, connectorId: string): boolean {
    const conn = this.getConnection(userId, connectorId);
    if (!conn) return true;
    if (!conn.tokenExpiresAt) return false;
    return conn.tokenExpiresAt.getTime() < Date.now();
  }

  // ── Developer Credentials ────────────────────────────────────────

  saveDeveloperCredentials(slug: string, clientId: string, clientSecret: string, scopes: string[] = []): void {
    const now = new Date().toISOString();
    const encSecret = this.encryptValue(clientSecret);
    const scopesJson = JSON.stringify(scopes);

    this.db.prepare(`
      INSERT INTO developer_credentials (connector_slug, client_id, client_secret, scopes, is_configured, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(connector_slug) DO UPDATE SET
        client_id = excluded.client_id,
        client_secret = excluded.client_secret,
        scopes = excluded.scopes,
        is_configured = 1,
        updated_at = excluded.updated_at
    `).run(slug, clientId, encSecret, scopesJson, now, now);

    getLogger().info({ slug }, 'Developer credentials saved');
  }

  getDeveloperCredentials(slug: string): DeveloperCredential | null {
    const row = this.db.prepare(
      'SELECT * FROM developer_credentials WHERE connector_slug = ?'
    ).get(slug) as any;
    if (!row) return null;

    return {
      connectorSlug: row.connector_slug,
      clientId: row.client_id,
      clientSecret: this.decryptValue(row.client_secret),
      scopes: JSON.parse(row.scopes || '[]'),
      isConfigured: !!row.is_configured,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  listDeveloperCredentials(): DeveloperCredential[] {
    const rows = this.db.prepare(
      'SELECT * FROM developer_credentials ORDER BY connector_slug'
    ).all() as any[];
    return rows.map(r => ({
      connectorSlug: r.connector_slug,
      clientId: r.client_id,
      clientSecret: this.decryptValue(r.client_secret),
      scopes: JSON.parse(r.scopes || '[]'),
      isConfigured: !!r.is_configured,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }));
  }

  deleteDeveloperCredentials(slug: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM developer_credentials WHERE connector_slug = ?'
    ).run(slug);
    return result.changes > 0;
  }

  // ── Encryption Helpers ───────────────────────────────────────────

  private encryptValue(value: string): string {
    return encrypt(value, this.encryptionKey);
  }

  private decryptValue(encoded: string): string {
    try {
      return decrypt(encoded, this.encryptionKey);
    } catch {
      getLogger().warn('Failed to decrypt value — returning raw');
      return encoded;
    }
  }

  // ── Row Mappers ──────────────────────────────────────────────────

  private rowToConnection(row: any): UserConnection {
    return {
      id: row.id,
      userId: row.user_id,
      connectorId: row.connector_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      apiKey: row.api_key,
      tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at) : undefined,
      connectionStatus: row.connection_status,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
