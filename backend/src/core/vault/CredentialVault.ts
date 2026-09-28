/**
 * CredentialVault — AES-256-GCM encrypted secret store, bound to the machine.
 *
 * The master key is derived via scrypt from THREE components:
 *   1. a real machine fingerprint (HWID — CPU id + motherboard serial on
 *      Windows, see native/win32/HardwareId.ts),
 *   2. an optional user passphrase,
 *   3. a random 32-byte machine key protected with Windows DPAPI
 *      (CurrentUser scope) in a sidecar file (vault.bin.key).
 *
 * Because the key is bound to the machine (HWID) and to the Windows user +
 * machine (DPAPI), a vault file copied to another machine cannot be
 * decrypted: the HWID differs, and the DPAPI blob cannot be unprotected
 * there. Legacy v1 envelopes (hwid+passphrase only) are migrated to v2 on
 * first successful unlock so existing secrets are preserved.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { getLogger } from '../Logger';

export interface VaultEntry {
  id: string;
  service: string;
  username: string;
  secret: string;
  createdAt: number;
  updatedAt: number;
}

export interface DpapiAdapter {
  protect(data: Buffer): Buffer | null;
  unprotect(data: Buffer): Buffer | null;
}

export interface CredentialVaultOptions {
  dataDir: string;
  /** Machine fingerprint; a real stable HWID in production, injectable in tests. */
  hwid?: string;
  passphrase?: string;
  /** Envelope filename. */
  file?: string;
  /** Sidecar filename for the DPAPI-protected machine key (default: <file>.key). */
  machineKeyFile?: string;
  /** DPAPI adapter (Windows by default; injectable to simulate other machines, or null to disable). */
  dpapi?: DpapiAdapter | null;
}

const KDF_SALT_LEN = 16;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
/** v2 envelope magic: UMB2. */
const MAGIC = Buffer.from('UMB2', 'ascii');
/** Legacy v1 KDF salt is derived from the hwid; v1 has no magic header. */
const LEGACY_DEFAULT_HWIDS = ['local-machine', 'hwid-default'];

/** Windows DPAPI via PowerShell ProtectedData (CurrentUser scope). */
function windowsDpapi(): DpapiAdapter | null {
  if (os.platform() !== 'win32') return null;
  const run = (mode: 'Protect' | 'Unprotect', b64: string): string | null => {
    try {
      // -EncodedCommand (UTF-16LE base64) avoids all shell-quoting pitfalls.
      const script =
        `$ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.Security; ` +
        `[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${mode}(` +
        `[Convert]::FromBase64String('${b64}'), $null, ` +
        `[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20_000,
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  };
  return {
    protect(data: Buffer): Buffer | null {
      const out = run('Protect', data.toString('base64'));
      return out ? Buffer.from(out, 'base64') : null;
    },
    unprotect(data: Buffer): Buffer | null {
      const out = run('Unprotect', data.toString('base64'));
      return out ? Buffer.from(out, 'base64') : null;
    },
  };
}

export class CredentialVault {
  private file: string;
  private machineKeyFile: string;
  private hwid: string;
  private passphrase: string;
  private dpapi: DpapiAdapter | null;
  private entries = new Map<string, VaultEntry>();
  private unlocked = false;
  private ensureMachineKeyFailedLogged = false;

  constructor(options: CredentialVaultOptions) {
    this.file = path.join(options.dataDir, options.file ?? 'vault.bin');
    this.machineKeyFile = path.join(options.dataDir, options.machineKeyFile ?? `${options.file ?? 'vault.bin'}.key`);
    this.hwid = options.hwid ?? 'hwid-default';
    this.passphrase = options.passphrase ?? '';
    // Explicit null disables DPAPI; undefined uses the Windows default.
    this.dpapi = options.dpapi !== undefined ? options.dpapi : windowsDpapi();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  // ── Machine key (DPAPI sidecar) ─────────────────────────────

  private readMachineKey(): Buffer | null {
    if (!fs.existsSync(this.machineKeyFile) || !this.dpapi) return null;
    const blob = fs.readFileSync(this.machineKeyFile);
    const key = this.dpapi.unprotect(blob);
    // Sidecar exists but cannot be unprotected (copied to another Windows
    // user/machine, or DPAPI unavailable) → treat the vault as locked rather
    // than silently falling back to a weaker key.
    if (!key) throw new Error('Vault is locked: machine key cannot be decrypted on this machine');
    return key;
  }

  private ensureMachineKey(): Buffer | null {
    if (!this.dpapi) return null;
    const existing = this.readMachineKey();
    if (existing) return existing;
    const fresh = crypto.randomBytes(KEY_LEN);
    const blob = this.dpapi.protect(fresh);
    if (!blob) return null;
    try {
      fs.writeFileSync(this.machineKeyFile, blob, { mode: 0o600 });
    } catch {
      return null;
    }
    return fresh;
  }

  // ── Key derivation ──────────────────────────────────────────

  /** v2 KDF: scrypt(hwid + passphrase + machineKey, random salt). */
  private deriveKeyV2(machineKey: Buffer | null, salt: Buffer): Buffer {
    const material = this.hwid + this.passphrase + (machineKey ? machineKey.toString('base64') : '');
    return crypto.scryptSync(material, salt, KEY_LEN);
  }

  /** v1 KDF (legacy): scrypt(hwid + passphrase, sha256(hwid) salt). */
  private deriveKeyV1(hwid: string): Buffer {
    const salt = crypto
      .createHash('sha256')
      .update(hwid + '::umbra-vault')
      .digest()
      .subarray(0, KDF_SALT_LEN);
    return crypto.scryptSync(hwid + this.passphrase, salt, KEY_LEN);
  }

  // ── Envelope ────────────────────────────────────────────────

  private decryptV2(raw: Buffer, machineKey: Buffer | null): boolean {
    const salt = raw.subarray(MAGIC.length, MAGIC.length + KDF_SALT_LEN);
    const iv = raw.subarray(MAGIC.length + KDF_SALT_LEN, MAGIC.length + KDF_SALT_LEN + IV_LEN);
    const tag = raw.subarray(MAGIC.length + KDF_SALT_LEN + IV_LEN, MAGIC.length + KDF_SALT_LEN + IV_LEN + TAG_LEN);
    const data = raw.subarray(MAGIC.length + KDF_SALT_LEN + IV_LEN + TAG_LEN);
    const key = this.deriveKeyV2(machineKey, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    this.entries = new Map(JSON.parse(plain).map((e: VaultEntry) => [e.id, e]));
    return true;
  }

  private decryptV1(raw: Buffer, hwid: string): boolean {
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = raw.subarray(IV_LEN + TAG_LEN);
    const key = this.deriveKeyV1(hwid);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    this.entries = new Map(JSON.parse(plain).map((e: VaultEntry) => [e.id, e]));
    return true;
  }

  unlock(): void {
    if (!fs.existsSync(this.file)) {
      this.unlocked = true;
      return;
    }
    const raw = fs.readFileSync(this.file);
    const isV2 = raw.length >= MAGIC.length + KDF_SALT_LEN + IV_LEN + TAG_LEN && raw.subarray(0, MAGIC.length).equals(MAGIC);

    try {
      if (isV2) {
        // Try with the DPAPI machine key first; if none exists, hwid-only.
        let machineKey: Buffer | null = null;
        try {
          machineKey = this.readMachineKey();
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        if (this.decryptV2(raw, machineKey)) {
          this.unlocked = true;
          return;
        }
        // DPAPI key present but wrong → locked.
        throw new Error('Vault is locked: wrong machine, wrong passphrase, or corrupted file');
      }

      // Legacy v1: try the real hwid, then the historical default hwids so
      // pre-HWID vaults keep working — and migrate them to v2 immediately.
      const candidates = Array.from(new Set([this.hwid, ...LEGACY_DEFAULT_HWIDS]));
      for (const hwid of candidates) {
        try {
          if (this.decryptV1(raw, hwid)) {
            // Legacy vault unlocked — re-persist as v2 (machine-key bound)
            // so the next write/read is protected by the real HWID + DPAPI.
            this.unlocked = true;
            this.persist();
            return;
          }
        } catch {
          // wrong key for this candidate — try the next
        }
      }
      throw new Error('Vault is locked: wrong machine, wrong passphrase, or corrupted file');
    } catch (err: any) {
      throw err instanceof Error && err.message.startsWith('Vault is locked')
        ? err
        : new Error('Vault is locked: wrong machine, wrong passphrase, or corrupted file');
    }
  }

  lock(): void {
    this.entries.clear();
    this.unlocked = false;
  }

  set(entry: Omit<VaultEntry, 'id' | 'createdAt' | 'updatedAt'>, id?: string): VaultEntry {
    this.assertUnlocked();
    const now = Date.now();
    const existing = id ? this.entries.get(id) : undefined;
    const full: VaultEntry = {
      id: id ?? crypto.randomBytes(8).toString('hex'),
      service: entry.service,
      username: entry.username,
      secret: entry.secret,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(full.id, full);
    this.persist();
    return full;
  }

  get(id: string): VaultEntry | undefined {
    this.assertUnlocked();
    return this.entries.get(id);
  }

  find(service: string, username?: string): VaultEntry | undefined {
    this.assertUnlocked();
    for (const e of this.entries.values()) {
      if (e.service === service && (!username || e.username === username)) return e;
    }
    return undefined;
  }

  delete(id: string): boolean {
    this.assertUnlocked();
    const removed = this.entries.delete(id);
    if (removed) this.persist();
    return removed;
  }

  list(): VaultEntry[] {
    this.assertUnlocked();
    return [...this.entries.values()].sort((a, b) => a.service.localeCompare(b.service));
  }

  /**
   * Remove an entry by service name. Returns true if found and removed.
   */
  remove(service: string): boolean {
    this.assertUnlocked();
    for (const [id, entry] of this.entries) {
      if (entry.service === service) {
        this.entries.delete(id);
        this.persist();
        return true;
      }
    }
    return false;
  }

  /** True when the on-disk envelope is v2 (machine-key bound). */
  get isV2(): boolean {
    if (!fs.existsSync(this.file)) return false;
    try {
      const raw = fs.readFileSync(this.file);
      return raw.subarray(0, MAGIC.length).equals(MAGIC);
    } catch {
      return false;
    }
  }

  private persist(): void {
    this.assertUnlocked();
    // Bind a DPAPI machine key when possible (Windows). On Linux/cloud there
    // is no DPAPI, so binding is hwid-only — still machine-unique.
    let machineKey: Buffer | null = null;
    try {
      machineKey = this.ensureMachineKey();
    } catch {
      machineKey = null;
    }
    if (this.dpapi && machineKey === null && !this.ensureMachineKeyFailedLogged) {
      getLogger().warn('Vault persisting with HWID+passphrase only — DPAPI machine key unavailable, security is degraded');
      this.ensureMachineKeyFailedLogged = true;
    }

    const salt = crypto.randomBytes(KDF_SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = this.deriveKeyV2(machineKey, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify([...this.entries.values()]), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([MAGIC, salt, iv, tag, data]);
    fs.writeFileSync(this.file, envelope, { mode: 0o600 });
  }

  private assertUnlocked(): void {
    if (!this.unlocked) throw new Error('Vault is locked; call unlock() first');
  }
}
