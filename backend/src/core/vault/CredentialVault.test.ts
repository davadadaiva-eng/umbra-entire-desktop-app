import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { CredentialVault, DpapiAdapter } from './CredentialVault';

/** In-memory DPAPI stand-in: round-trips on the 'same machine', fails elsewhere. */
function makeDpapi(ok: boolean): DpapiAdapter {
  return {
    protect: (b: Buffer) => (ok ? Buffer.from(`dp:${b.toString('base64')}`) : null),
    unprotect: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!ok || !s.startsWith('dp:')) return null;
      return Buffer.from(s.slice(3), 'base64');
    },
  };
}

/** Build a legacy v1 envelope (iv|tag|data) with the old KDF, as the old code wrote it. */
function writeLegacyV1(file: string, hwid: string, passphrase: string, entries: Array<{ service: string; username: string; secret: string }>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const salt = crypto.createHash('sha256').update(hwid + '::umbra-vault').digest().subarray(0, 16);
  const key = crypto.scryptSync(hwid + passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(entries.map((e, i) => ({ id: `id${i}`, ...e, createdAt: 1, updatedAt: 1 }))), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(file, Buffer.concat([iv, tag, data]));
}

const dir = path.join(os.tmpdir(), `umbra-vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const freshDir = () => path.join(dir, Math.random().toString(36).slice(2, 10));

describe('CredentialVault', () => {
  it('round-trips secrets encrypted at rest', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', passphrase: 'pw' });
    vault.unlock();
    vault.set({ service: 'telnyx', username: 'acct', secret: 'tok-abc' });
    vault.set({ service: 'github', username: 'me', secret: 'ghp_xyz' });

    const reloaded = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', passphrase: 'pw' });
    reloaded.unlock();
    expect(reloaded.find('telnyx')?.secret).toBe('tok-abc');
    expect(reloaded.find('github')?.username).toBe('me');
  });

  it('refuses to unlock with the wrong passphrase', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', passphrase: 'pw' });
    vault.unlock();
    vault.set({ service: 'x', username: 'u', secret: 's' });

    const attacker = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', passphrase: 'wrong' });
    expect(() => attacker.unlock()).toThrow(/locked|wrong/);
  });

  it('refuses to unlock on a different machine (HWID bound)', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', passphrase: 'pw' });
    vault.unlock();
    vault.set({ service: 'x', username: 'u', secret: 's' });

    const other = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-2', passphrase: 'pw' });
    expect(() => other.unlock()).toThrow(/locked|wrong/);
  });

  it('blocks access while locked', () => {
    const vault = new CredentialVault({ dataDir: freshDir(), hwid: 'machine-1' });
    expect(() => vault.list()).toThrow(/locked/);
  });

  it('lock() clears in-memory entries', () => {
    const vault = new CredentialVault({ dataDir: freshDir(), hwid: 'machine-1' });
    vault.unlock();
    vault.set({ service: 'x', username: 'u', secret: 's' });
    vault.lock();
    expect(vault.isUnlocked).toBe(false);
    expect(() => vault.get('any')).toThrow(/locked/);
  });

  it('vault file is not plaintext', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1' });
    vault.unlock();
    vault.set({ service: 'x', username: 'u', secret: 'super-secret-value' });
    const raw = require('fs').readFileSync(path.join(vaultDir, 'vault.bin'), 'utf8');
    expect(raw).not.toContain('super-secret-value');
  });

  it('writes a v2 envelope bound to a DPAPI machine key (sidecar)', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: makeDpapi(true) });
    vault.unlock();
    vault.set({ service: 'github', username: 'me', secret: 'ghp_xyz' });
    expect(vault.isV2).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'vault.bin.key'))).toBe(true);

    const reloaded = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: makeDpapi(true) });
    reloaded.unlock();
    expect(reloaded.find('github')?.secret).toBe('ghp_xyz');
  });

  it('rejects a vault copied to another machine (DPAPI sidecar undecryptable)', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: makeDpapi(true) });
    vault.unlock();
    vault.set({ service: 'x', username: 'u', secret: 's' });

    // Same files, but on 'another machine' the DPAPI blob cannot be
    // unprotected (and the HWID differs) → must stay locked, never fall back.
    const other = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-2', dpapi: makeDpapi(false) });
    expect(() => other.unlock()).toThrow(/locked/);
  });

  it('rejects a v2 vault copied without the sidecar to another machine', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: makeDpapi(true) });
    vault.unlock();
    vault.set({ service: 'x', username: 'u', secret: 's' });
    fs.rmSync(path.join(vaultDir, 'vault.bin.key')); // attacker copies only vault.bin

    const other = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-2', dpapi: makeDpapi(true) });
    expect(() => other.unlock()).toThrow(/locked/);
  });

  it('falls back to hwid-only binding when DPAPI is unavailable (Linux cloud)', () => {
    const vaultDir = freshDir();
    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: null });
    vault.unlock();
    vault.set({ service: 'x', username: 'u', secret: 's' });
    expect(vault.isV2).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'vault.bin.key'))).toBe(false);

    const reloaded = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: null });
    reloaded.unlock();
    expect(reloaded.find('x')?.secret).toBe('s');
  });

  it('migrates a legacy v1 vault to v2 on first unlock (preserves secrets)', () => {
    const vaultDir = freshDir();
    const file = path.join(vaultDir, 'vault.bin');
    writeLegacyV1(file, 'local-machine', '', [{ service: 'telnyx', username: 'acct', secret: 'tok-legacy' }]);

    const vault = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: makeDpapi(true) });
    vault.unlock();
    expect(vault.find('telnyx')?.secret).toBe('tok-legacy');
    expect(vault.isV2).toBe(true); // re-persisted, machine-bound
    expect(fs.existsSync(path.join(vaultDir, 'vault.bin.key'))).toBe(true);

    const reloaded = new CredentialVault({ dataDir: vaultDir, hwid: 'machine-1', dpapi: makeDpapi(true) });
    reloaded.unlock();
    expect(reloaded.find('telnyx')?.secret).toBe('tok-legacy');
  });
});

