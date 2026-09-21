/**
 * MeshBridge — embeds the Rust Umbra Mesh daemon (umbra-meshd) as an optional
 * P2P transport alongside the existing WebSocket signaling hub.
 *
 * The daemon owns the zero-knowledge identity + pairing store (Ed25519/X25519,
 * QR wire payloads, OS keystore) and is driven over stdio JSON-RPC by the
 * host-side MeshDaemonClient (mesh/ts). This bridge starts/stops the daemon
 * and exposes the RPC surface through Umbra's API. It is fully optional:
 * when `p2p.meshEnabled` is off, or the daemon binary is not built, the bridge
 * reports `running: false` instead of failing boot.
 */

import { getLogger } from '../core/Logger';

/** Structural type for the mesh daemon client so the bridge can run in tests
 *  without requiring the Rust binary to be built. MeshDaemonClient (mesh/ts)
 *  satisfies this shape. */
export interface MeshDaemonLike {
  running: boolean;
  start(exePath?: string, opts?: { dataDir?: string; keystore?: string; name?: string }): Promise<void>;
  stop(timeoutMs?: number): Promise<void>;
  status(): Promise<Record<string, unknown>>;
  pairCreate(ttl?: number): Promise<Record<string, unknown>>;
  pairVerify?(wire: unknown): Promise<Record<string, unknown>>;
  pairDemo(): Promise<Record<string, unknown>>;
  devicesList(): Promise<{ devices?: unknown[] }>;
  devicesRevoke(deviceId: string): Promise<{ ok?: boolean; device_id?: string }>;
}

export interface MeshBridgeOptions {
  enabled: boolean;
  dataDir: string;
  name?: string;
  /** Optional binary path; defaults to MeshDaemonClient.findBinary(). */
  exePath?: string;
  /** Injectable client (defaults to MeshDaemonClient). */
  client?: MeshDaemonLike;
  /** Locate the binary lazily on start (throws when missing). */
  findBinary?: () => string;
}

export class MeshBridge {
  private opts: MeshBridgeOptions;
  private client: MeshDaemonLike | null = null;
  private started = false;

  constructor(opts: MeshBridgeOptions) {
    this.opts = opts;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  get running(): boolean {
    return this.client?.running === true;
  }

  /** Start the daemon if enabled and the binary exists. Never throws. */
  async start(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.opts.enabled) return { ok: false, reason: 'disabled (p2p.meshEnabled=false)' };
    if (this.running) return { ok: true };
    let client = this.opts.client;
    let exePath = this.opts.exePath;
    if (!client) {
      try {
        // Lazy-require the host binding so headless builds without mesh/ts
        // still boot (the bridge simply reports running:false). Try the
        // compiled dist first (production), then the TS source (ts-node dev).
        const mod = this.loadHostBinding();
        client = new mod.MeshDaemonClient();
        if (!exePath) {
          const find = this.opts.findBinary ?? mod.MeshDaemonClient.findBinary;
          exePath = find();
        }
      } catch (err) {
        getLogger().debug({ err: err instanceof Error ? err.message : String(err) }, 'Mesh daemon client unavailable');
        return { ok: false, reason: 'mesh daemon client unavailable' };
      }
    }
    try {
      await client!.start(exePath, {
        dataDir: this.opts.dataDir,
        keystore: process.platform === 'win32' ? 'os' : 'file',
        name: this.opts.name,
      });
      this.client = client!;
      this.started = true;
      getLogger().info({ dataDir: this.opts.dataDir }, 'Umbra mesh daemon started');
      return { ok: true };
    } catch (err) {
      getLogger().debug({ err: err instanceof Error ? err.message : String(err) }, 'Mesh daemon start failed — mesh disabled');
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    if (this.client?.running) {
      try {
        await this.client.stop(2000);
      } catch (err) {
        getLogger().debug({ err: err instanceof Error ? err.message : String(err) }, 'Mesh daemon stop failed');
      }
    }
    this.client = null;
    this.started = false;
  }

  async status(): Promise<Record<string, unknown>> {
    if (!this.running) return { running: false, enabled: this.opts.enabled, reason: this.started ? 'stopped' : 'not started' };
    try {
      const status = await this.client!.status();
      return { running: true, enabled: this.opts.enabled, ...status };
    } catch (err) {
      return { running: false, enabled: this.opts.enabled, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async pair(ttl = 120): Promise<Record<string, unknown>> {
    if (!this.running) throw new Error('Mesh daemon not running');
    return this.client!.pairCreate(ttl);
  }

  async pairDemo(): Promise<Record<string, unknown>> {
    if (!this.running) throw new Error('Mesh daemon not running');
    return this.client!.pairDemo();
  }

  async devices(): Promise<{ devices: unknown[] }> {
    if (!this.running) return { devices: [] };
    const res = await this.client!.devicesList();
    return { devices: res.devices ?? [] };
  }

  async revoke(deviceId: string): Promise<{ ok: boolean; deviceId: string }> {
    if (!this.running) throw new Error('Mesh daemon not running');
    const res = await this.client!.devicesRevoke(deviceId);
    return { ok: res.ok !== false, deviceId: res.device_id ?? deviceId };
  }

  /** Load the mesh host binding (MeshDaemonClient) from dist or src. */
  private loadHostBinding(): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('module');
    const candidates = ['../../mesh/ts/dist/index', '../../mesh/ts/src/index'];
    let lastErr: unknown;
    for (const c of candidates) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return mod.createRequire(__filename)(c);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('mesh host binding not found');
  }
}
