import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AuditEntry } from '../../types';
import { getLogger } from '../Logger';

export class AuditVault {
  private entries: AuditEntry[] = [];
  private vaultDir: string;
  private currentLogFile: string;
  private lastHash: string = '0';
  private signingKey: crypto.KeyObject;
  private initialized: boolean = false;

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
    this.currentLogFile = path.join(vaultDir, `audit-${new Date().toISOString().split('T')[0]}.jsonl`);
    this.signingKey = crypto.createPrivateKey({
      key: this.getOrCreateKey(),
      format: 'pem',
      type: 'pkcs8',
    });
  }

  initialize(): void {
    if (!fs.existsSync(this.vaultDir)) {
      fs.mkdirSync(this.vaultDir, { recursive: true });
    }

    if (fs.existsSync(this.currentLogFile)) {
      const lines = fs.readFileSync(this.currentLogFile, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;
          if (entry) {
            this.entries.push(entry);
            this.lastHash = entry.previousHash;
          }
        } catch { }
      }
    }

    this.initialized = true;
    getLogger().info({ entryCount: this.entries.length }, 'Audit vault initialized');
  }

  log(action: string, target: string, params: Record<string, unknown>, result: string, swarmId?: number): void {
    if (!this.initialized) return;

    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      action,
      target,
      params,
      result,
      signature: '',
      previousHash: this.lastHash,
      swarmId,
    };

    entry.signature = this.signEntry(entry);
    this.entries.push(entry);
    this.lastHash = this.hashEntry(entry);

    try {
      fs.appendFileSync(this.currentLogFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err: any) {
      getLogger().error({ err: err.message }, 'Failed to write audit entry');
    }
  }

  verifyChain(): { valid: boolean; brokenAt?: number } {
    let previousHash = '0';

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      if (entry.previousHash !== previousHash) {
        return { valid: false, brokenAt: i };
      }

      const expectedHash = this.hashEntry(entry);
      previousHash = expectedHash;

      const publicKey = crypto.createPublicKey(this.signingKey);
      const verifier = crypto.createVerify('SHA256');
      verifier.update(entry.id + entry.timestamp.toISOString() + entry.action + entry.target + JSON.stringify(entry.params) + entry.result + entry.previousHash);
      const valid = verifier.verify(publicKey, Buffer.from(entry.signature, 'hex'));

      if (!valid) {
        return { valid: false, brokenAt: i };
      }
    }

    return { valid: true };
  }

  getEntries(filter?: { action?: string; target?: string; since?: Date }): AuditEntry[] {
    let filtered = this.entries;
    if (filter?.action) filtered = filtered.filter(e => e.action === filter.action);
    if (filter?.target) filtered = filtered.filter(e => e.target.includes(filter.target!));
    if (filter?.since) filtered = filtered.filter(e => e.timestamp >= filter.since!);
    return filtered;
  }

  getStats(): { totalEntries: number; uniqueActions: number; firstEntry?: Date; lastEntry?: Date; chainValid: boolean } {
    return {
      totalEntries: this.entries.length,
      uniqueActions: new Set(this.entries.map(e => e.action)).size,
      firstEntry: this.entries[0]?.timestamp,
      lastEntry: this.entries[this.entries.length - 1]?.timestamp,
      chainValid: this.verifyChain().valid,
    };
  }

  private signEntry(entry: Omit<AuditEntry, 'signature'>): string {
    const signer = crypto.createSign('SHA256');
    signer.update(entry.id + entry.timestamp.toISOString() + entry.action + entry.target + JSON.stringify(entry.params) + entry.result + entry.previousHash);
    return signer.sign(this.signingKey, 'hex');
  }

  private hashEntry(entry: AuditEntry): string {
    return crypto
      .createHash('SHA256')
      .update(entry.id + entry.timestamp.toISOString() + entry.action + entry.target + JSON.stringify(entry.params) + entry.result + entry.previousHash + entry.signature)
      .digest('hex');
  }

  private getOrCreateKey(): string {
    const keyPath = path.join(this.vaultDir, 'signing-key.pem');
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath, 'utf-8');
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    fs.writeFileSync(keyPath, privateKey, 'utf-8');
    fs.writeFileSync(path.join(this.vaultDir, 'verification-key.pem'), publicKey, 'utf-8');
    return privateKey;
  }
}
