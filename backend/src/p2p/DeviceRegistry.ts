import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../core/Logger';

export type DeviceRole = 'desktop' | 'phone' | 'server' | 'other';

export interface RegisteredDevice {
  deviceId: string;
  name: string;
  role: DeviceRole;
  capabilities: string[];
  /** SHA-256 of the device token — the raw token is only returned once. */
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
}

export interface DeviceInvite {
  code: string;
  expiresAt: number;
  name?: string;
}

/**
 * DeviceRegistry — the cloud's persistent device directory.
 *
 * Devices join once (QR code on the phone, or a link on the PC) and receive a
 * long-lived token. They reconnect with that token forever, so the hub can
 * keep every device "always connected" without re-pairing. Registry state is
 * written to disk so it survives hub restarts — the thing that actually makes
 * the connection permanent is the client's auto-reconnect + this persisted
 * token, not a single live socket.
 */
export class DeviceRegistry {
  private devices = new Map<string, RegisteredDevice>();
  private invites = new Map<string, DeviceInvite>();
  private statePath: string;
  private inviteTtlMs: number;

  constructor(options: { dataDir: string; inviteTtlMs?: number }) {
    this.statePath = path.join(options.dataDir, 'devices.json');
    this.inviteTtlMs = options.inviteTtlMs ?? 10 * 60 * 1000;
    this.load();
  }

  /** Create a short-lived invite code (rendered as a QR or a join link). */
  createInvite(name?: string): DeviceInvite {
    this.purgeInvites();
    const code = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, '').substring(0, 12);
    const invite: DeviceInvite = { code, expiresAt: Date.now() + this.inviteTtlMs, name };
    this.invites.set(code, invite);
    getLogger().info({ code }, 'Device invite created');
    return invite;
  }

  /** Redeem an invite: register the device and hand back its one-time token. */
  redeemInvite(
    code: string,
    meta: { name: string; role?: DeviceRole; capabilities?: string[] },
  ): { deviceId: string; token: string; device: RegisteredDevice } {
    const invite = this.invites.get(code);
    if (!invite) throw new Error('Unknown invite code');
    if (Date.now() > invite.expiresAt) {
      this.invites.delete(code);
      throw new Error('Invite code expired');
    }
    this.invites.delete(code);

    const token = crypto.randomBytes(32).toString('hex');
    const deviceId = `device-${crypto.randomBytes(6).toString('hex')}`;
    const device: RegisteredDevice = {
      deviceId,
      name: meta.name || invite.name || 'Device',
      role: meta.role ?? 'other',
      capabilities: meta.capabilities ?? [],
      tokenHash: this.hashToken(token),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.devices.set(deviceId, device);
    this.save();
    getLogger().info({ deviceId, name: device.name, role: device.role }, 'Device registered');
    return { deviceId, token, device };
  }

  /** Verify a device token on reconnect. Returns the device or null. */
  authenticate(token: string): RegisteredDevice | null {
    if (!token) return null;
    const hash = this.hashToken(token);
    for (const device of this.devices.values()) {
      if (device.tokenHash === hash) return device;
    }
    return null;
  }

  /** Update the in-memory lastSeen (called on every heartbeat; no disk write). */
  touch(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) device.lastSeen = Date.now();
  }

  /** Update lastSeen and persist (called when a device (re)connects). */
  markSeen(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
      this.save();
    }
  }

  getDevice(deviceId: string): RegisteredDevice | undefined {
    return this.devices.get(deviceId);
  }

  listDevices(): RegisteredDevice[] {
    return [...this.devices.values()];
  }

  revokeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
    this.save();
    getLogger().info({ deviceId }, 'Device revoked');
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private purgeInvites(): void {
    const now = Date.now();
    for (const [code, invite] of this.invites) {
      if (invite.expiresAt < now) this.invites.delete(code);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify([...this.devices.values()], null, 2), 'utf-8');
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Failed to persist device registry');
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const rows = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as RegisteredDevice[];
      for (const d of rows) this.devices.set(d.deviceId, d);
      getLogger().info({ count: this.devices.size }, 'Loaded device registry');
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Failed to load device registry');
    }
  }
}
