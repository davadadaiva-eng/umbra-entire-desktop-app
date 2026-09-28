import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EncryptedChannel } from './crypto/EncryptedChannel';
import { getLogger } from '../core/Logger';

export interface PairingPayload {
  sessionId: string;
  host: string;
  port: number;
  publicKeyPem: string;
  expiresAt: number;
  deviceId: string;
}

export interface PairedDevice {
  deviceId: string;
  name: string;
  createdAt: number;
  sharedSecretB64: string;
  lastSeen: number;
}

export interface PairingSession {
  sessionId: string;
  publicKeyPem: string;
  expiresAt: number;
  used: boolean;
}

/**
 * PairingManager — encrypted QR-code pairing.
 *
 * The PC generates a short-lived pairing session whose payload (session id,
 * ECDH public key, connection endpoint) is rendered as a QR code. The phone
 * scans it, performs ECDH, and exchanges its own public key over the
 * signaling channel. Both sides derive the same AES-256-GCM key locally —
 * no cloud account, no central credential store.
 */
export class PairingManager {
  private privateKey: crypto.KeyObject;
  private publicKeyPem: string;
  private hostDeviceId: string;
  private sessions = new Map<string, PairingSession>();
  private devices = new Map<string, PairedDevice>();
  private statePath: string;
  private sessionTtlMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: { dataDir: string; sessionTtlMs?: number }) {
    const { privateKey, publicKeyPem } = EncryptedChannel.generateKeyPair();
    this.privateKey = privateKey;
    this.publicKeyPem = publicKeyPem;
    this.hostDeviceId = `umbra-${crypto.randomBytes(4).toString('hex')}`;
    this.sessionTtlMs = options.sessionTtlMs ?? 5 * 60 * 1000;
    this.statePath = path.join(options.dataDir, 'p2p-paired.json');
    this.loadDevices();
    this.startCleanupTimer();
  }

  /** Returns an existing valid session for the given host/port, or creates a new one. */
  createSession(host: string, port: number): PairingPayload {
    // Deduplication: find an existing valid session for this host/port
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.used && session.expiresAt > now) {
        // Found a valid unused session - return it with updated expiry
        const payload: PairingPayload = {
          sessionId: session.sessionId,
          host,
          port,
          publicKeyPem: this.publicKeyPem,
          expiresAt: session.expiresAt,
          deviceId: this.hostDeviceId,
         };
         getLogger().debug({ sessionId: session.sessionId }, 'P2P pairing session reused');
         return payload;
       }
     }

     // No valid session exists - create a new one
     this.purgeExpired();
     const sessionId = crypto.randomBytes(16).toString('hex');
     const payload: PairingPayload = {
       sessionId,
       host,
       port,
       publicKeyPem: this.publicKeyPem,
       expiresAt: Date.now() + this.sessionTtlMs,
       deviceId: this.hostDeviceId,
     };
    this.sessions.set(sessionId, {
      sessionId,
      publicKeyPem: this.publicKeyPem,
      expiresAt: payload.expiresAt,
      used: false,
    });
    getLogger().debug({ sessionId }, 'P2P pairing session created');
    return payload;
  }

  /** Get the current active (unused, unexpired) session payload without creating a new one. */
  getActiveSession(host: string, port: number): PairingPayload | null {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.used && session.expiresAt > now) {
        return {
          sessionId: session.sessionId,
          host,
          port,
          publicKeyPem: this.publicKeyPem,
          expiresAt: session.expiresAt,
           deviceId: this.hostDeviceId,
         };
       }
     }
     return null;
  }

  /** Stop the periodic cleanup timer and clear all sessions. */
  cleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
    getLogger().debug('PairingManager cleaned up');
  }

  private startCleanupTimer(): void {
    // Run cleanup every 60 seconds
    this.cleanupTimer = setInterval(() => {
      this.purgeExpired();
    }, 60_000);
    this.cleanupTimer.unref(); // Don't keep process alive
  }

  private purgeExpired(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt < now) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      getLogger().debug({ removed }, 'P2P pairing sessions purged');
    }
  }

  /** JSON string the PWA renders as a QR code (scannable once). */
  qrPayload(host: string, port: number): string {
    return JSON.stringify(this.createSession(host, port));
  }

  /** Complete pairing: validate session, derive shared secret from the
   * phone's ECDH public key. */
  completePairing(payload: { sessionId: string; name: string; devicePublicKeyPem: string }): { deviceId: string; channel: EncryptedChannel } {
    const session = this.sessions.get(payload.sessionId);
    if (!session) throw new Error('Unknown pairing session');
    if (Date.now() > session.expiresAt) throw new Error('Pairing session expired');
    if (session.used) throw new Error('Pairing session already used');
    session.used = true;

    // Validate the peer's public key before consuming the session slot.
    try {
      crypto.createPublicKey(payload.devicePublicKeyPem);
    } catch {
      session.used = false;
      throw new Error('Invalid device public key');
    }

    const shared = EncryptedChannel.deriveSharedSecret(this.privateKey, payload.devicePublicKeyPem);
    const deviceId = `device-${crypto.randomBytes(6).toString('hex')}`;
    const device: PairedDevice = {
      deviceId,
      name: payload.name || 'Phone',
      createdAt: Date.now(),
      sharedSecretB64: shared.toString('base64'),
      lastSeen: Date.now(),
    };
    this.devices.set(deviceId, device);
    this.saveDevices();

    getLogger().info({ deviceId, name: device.name }, 'P2P device paired');
    return { deviceId, channel: new EncryptedChannel(shared) };
  }

  getDevice(deviceId: string): PairedDevice | undefined {
    return this.devices.get(deviceId);
  }

  openChannel(deviceId: string): EncryptedChannel | null {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return new EncryptedChannel(Buffer.from(device.sharedSecretB64, 'base64'));
  }

  touch(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
      this.saveDevices();
    }
  }

  listDevices(): PairedDevice[] {
    return [...this.devices.values()];
  }

  revokeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
    this.saveDevices();
    getLogger().info({ deviceId }, 'P2P device revoked');
  }

  private saveDevices(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify([...this.devices.values()], null, 2), 'utf-8');
      try { fs.chmodSync(this.statePath, 0o600); } catch { /* non-POSIX */ }
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'Failed to persist paired devices');
    }
  }

  private loadDevices(): void {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const rows = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as PairedDevice[];
      for (const d of rows) this.devices.set(d.deviceId, d);
      getLogger().info({ count: this.devices.size }, 'Loaded paired P2P devices');
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'Failed to load paired devices');
    }
  }
}
