/**
 * MeshDaemonClient — TypeScript host binding for the Umbra Mesh daemon.
 *
 * Spawns `umbra-meshd.exe` (or `umbra-meshd`) and drives it with
 * newline-delimited JSON-RPC 2.0 over stdio. Logs from the daemon go to
 * stderr, so stdout is exclusively the RPC channel.
 *
 * ```ts
 * const mesh = new MeshDaemonClient();
 * await mesh.start(exePath, { dataDir });
 * const status = await mesh.status();
 * const qr = await mesh.pairCreate({ ttl: 120 });
 * await mesh.stop();
 * ```
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── wire types (mirror the Rust contract) ────────────────────────────────

export interface PairingPayload {
  v: number;
  id: string;
  pub: string; // ed25519 b64
  xp: string; // x25519 static b64
  addrs: string[];
  nonce: string;
  exp: number;
}

export interface SignedPairing {
  payload: PairingPayload;
  sig: string;
}

export interface DeviceRow {
  device_id: string;
  device_name: string;
  device_type: string;
  public_key: string;
  x_public_key: string;
  permission_level: string;
  last_seen_at: string;
  created_at: string;
}

export interface MeshStatus {
  ok: boolean;
  proto: string;
  version: string;
  identity: {
    name: string;
    device_id: string;
    ed_pub: string;
    xp: string;
    created: boolean;
  };
  keystore: string;
  data_dir: string;
  addrs: string[];
  paired_devices: number;
}

export interface PairCreateResult {
  device_id: string;
  wire: SignedPairing;
  exp: number;
  qr_ascii: string;
}

export interface PairRespondResult {
  ok: boolean;
  device_id: string;
  pairing: boolean;
  session_key: string;
}

export interface PairDemoResult {
  ok: boolean;
  match: boolean;
  device_id: string;
  desktop_session_key: string;
  client_session_key: string;
  message: string;
}

export interface RpcErrorPayload {
  code: number;
  message: string;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly method: string,
  ) {
    super(`mesh rpc ${method} failed (${code}): ${message}`);
    this.name = 'RpcError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// ── client ───────────────────────────────────────────────────────────────

export interface MeshDaemonOptions {
  dataDir?: string;
  keystore?: 'os' | 'file';
  name?: string;
  rpcTimeoutMs?: number;
}

export class MeshDaemonClient {
  private child?: ChildProcess;
  private rl?: Interface;
  private pending = new Map<number | string, Pending>();
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private seq = 0;
  private exePath = '';
  private opts: MeshDaemonOptions = {};
  private stoppedByHost = false;

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  /** Locate the built daemon binary (release first, then debug), walking up
   *  from `cwd` so it works from `ts/`, `ts/dist/`, or the repo root. */
  static findBinary(cwd = process.cwd()): string {
    const exe = process.platform === 'win32' ? 'umbra-meshd.exe' : 'umbra-meshd';
    for (let dir = path.resolve(cwd), depth = 0; depth < 4; depth++, dir = path.dirname(dir)) {
      for (const profile of ['release', 'debug']) {
        const c = path.join(dir, 'target', profile, exe);
        if (fs.existsSync(c)) return c;
      }
      if (path.dirname(dir) === dir) break;
    }
    throw new Error(
      `umbra-meshd binary not found. Build it first: cargo build --release (searched from ${cwd})`,
    );
  }

  /** Spawn the daemon. Resolves once the process is alive; first RPC
   *  implicitly waits for readiness. */
  async start(exePath?: string, opts: MeshDaemonOptions = {}): Promise<void> {
    if (this.running) throw new Error('mesh daemon already running');
    this.exePath = exePath ?? MeshDaemonClient.findBinary();
    this.opts = opts;

    const args: string[] = [];
    if (opts.dataDir) args.push('--data-dir', opts.dataDir);
    if (opts.keystore) args.push('--keystore', opts.keystore);
    if (opts.name) args.push('--name', opts.name);

    const child = spawn(this.exePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stoppedByHost = false;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl = rl;
    rl.on('line', (line) => this.onLine(line));

    child.on('error', (err) => {
      this.failAll(new Error(`mesh daemon spawn error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      const err = new Error(
        this.stoppedByHost
          ? 'mesh daemon stopped'
          : `mesh daemon exited unexpectedly (code=${code} signal=${signal})`,
      );
      this.failAll(err);
      this.child = undefined;
      this.rl?.close();
      this.rl = undefined;
    });

    // The first RPC call proves the daemon is ready (it reads from stdin).
    await Promise.resolve();
  }

  /** Generic JSON-RPC call. Throws {@link RpcError} on error responses. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.child || this.child.exitCode !== null) {
      throw new Error('mesh daemon is not running');
    }
    const id = ++this.seq;
    const request = { jsonrpc: '2.0', id, method, params };

    const timeout = timeoutMs ?? this.opts.rpcTimeoutMs ?? 15000;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mesh rpc ${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });

    this.child.stdin?.write(JSON.stringify(request) + '\n');

    const reply = (await result) as { result?: unknown; error?: RpcErrorPayload };
    if (reply.error) {
      throw new RpcError(reply.error.code, reply.error.message, method);
    }
    return reply.result as T;
  }

  // ── typed helpers ──────────────────────────────────────────────────────

  status(): Promise<MeshStatus> {
    return this.call('mesh.status', {});
  }

  pairCreate(ttl = 120): Promise<PairCreateResult> {
    return this.call('mesh.pair.create', { ttl });
  }

  pairVerify(wire: SignedPairing): Promise<Record<string, unknown>> {
    return this.call('mesh.pair.verify', { wire: JSON.stringify(wire) });
  }

  pairRespond(params: {
    wire: SignedPairing;
    ephPubB64: string;
    deviceName?: string;
    deviceType?: 'mobile' | 'tablet' | 'wearable' | 'desktop';
    permissionLevel?: 'admin' | 'monitor' | 'compute' | 'standard';
  }): Promise<PairRespondResult> {
    return this.call('mesh.pair.respond', {
      wire: JSON.stringify(params.wire),
      eph_pub: params.ephPubB64,
      device_name: params.deviceName,
      device_type: params.deviceType,
      permission_level: params.permissionLevel,
    });
  }

  /** Test/demo-only: full handshake on one host, returns matching keys. */
  pairDemo(): Promise<PairDemoResult> {
    return this.call('mesh.pair.demo', {});
  }

  devicesList(): Promise<{ devices: DeviceRow[] }> {
    return this.call('mesh.devices.list', {});
  }

  devicesRevoke(deviceId: string): Promise<{ ok: boolean; device_id: string }> {
    return this.call('mesh.devices.revoke', { device_id: deviceId });
  }

  // ── events ─────────────────────────────────────────────────────────────

  /** Subscribe to daemon events (notifications without `id`). Returns an
   *  unsubscribe function. */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** Stop the daemon (graceful: `mesh.shutdown`, then SIGKILL fallback). */
  async stop(timeoutMs = 3000): Promise<void> {
    this.stoppedByHost = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 'shutdown', method: 'mesh.shutdown', params: {} }) + '\n');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, timeoutMs);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      child.kill('SIGKILL');
    }
    this.child = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: RpcErrorPayload };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore stray output (shouldn't happen; daemon logs to stderr)
    }
    if (msg.method) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const set = this.listeners.get(msg.method);
      if (set) for (const cb of [...set]) cb(params);
      return;
    }
    const p = msg.id != null ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    p.resolve({ result: msg.result, error: msg.error });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
