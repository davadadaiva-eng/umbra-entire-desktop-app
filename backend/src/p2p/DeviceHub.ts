import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { DeviceRegistry, RegisteredDevice } from './DeviceRegistry';
import { getLogger } from '../core/Logger';

export interface DeviceHubOptions {
  registry: DeviceRegistry;
  port: number;
  /** Drop a connection that has been silent this long (ms). */
  heartbeatTimeoutMs?: number;
  /** How often to sweep for dead connections (ms). */
  sweepIntervalMs?: number;
}

interface HubConnection {
  device?: RegisteredDevice;
  lastSeen: number;
}

/**
 * DeviceHub — the always-on cloud node every device stays connected to.
 *
 * Devices authenticate with the long-lived token issued at join time, then
 * send heartbeats. The hub relays messages device→device (e.g. a phone sends
 * a command addressed to the desktop) and broadcasts presence so every device
 * knows who is online. Because tokens and the registry persist on disk and
 * clients auto-reconnect, the mesh "never disconnects" even across restarts.
 */
export class DeviceHub {
  private registry: DeviceRegistry;
  private port: number;
  private heartbeatTimeoutMs: number;
  private sweepIntervalMs: number;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Map<WebSocket, HubConnection>();
  private byDevice = new Map<string, WebSocket>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private pendingRequests = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** 1s coalesce window for high-frequency pushes (progress / presence). */
  private readonly COALESCE_MS = 1000;
  private progressLastAt = new Map<string, number>();
  private progressPending = new Map<string, { msg: Record<string, unknown>; timer: NodeJS.Timeout }>();
  private presenceLastSent = new Map<string, { online: boolean; at: number }>();
  private presencePending = new Map<string, { online: boolean; timer: NodeJS.Timeout }>();

  constructor(options: DeviceHubOptions) {
    this.registry = options.registry;
    this.port = options.port;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 15_000;
  }

  start(): void {
    if (this.httpServer) return;
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/device-ws' });

    this.wss.on('connection', (ws, req) => {
      const conn: HubConnection = { lastSeen: Date.now() };
      this.connections.set(ws, conn);

      ws.on('message', raw => this.handleMessage(ws, raw));
      ws.on('close', () => this.onDisconnect(ws));
      ws.on('error', () => this.onDisconnect(ws));
      ws.on('pong', () => { conn.lastSeen = Date.now(); });

      getLogger().info({ remote: req.socket.remoteAddress }, 'Device connected (awaiting auth)');
    });

    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.httpServer.listen(this.port, () => {
      getLogger().info({ port: this.port }, 'DeviceHub listening');
    });
  }

  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error('DeviceHub stopped'));
    }
    this.pendingRequests.clear();
    for (const [, p] of this.progressPending) {
      try { clearTimeout(p.timer); } catch {}
    }
    this.progressPending.clear();
    for (const [, p] of this.presencePending) {
      try { clearTimeout(p.timer); } catch {}
    }
    this.presencePending.clear();
    for (const ws of this.connections.keys()) {
      try { ws.close(); } catch { }
    }
    this.connections.clear();
    this.byDevice.clear();
    if (this.wss) { try { this.wss.close(); } catch { } this.wss = null; }
    if (this.httpServer) { try { this.httpServer.close(); } catch { } this.httpServer = null; }
    getLogger().info('DeviceHub stopped');
  }

  /** Send a message to a connected device from the hub itself. */
  send(deviceId: string, msg: Record<string, unknown>): boolean {
    const ws = this.byDevice.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    this.sendJson(ws, { ...msg, from: 'hub' });
    return true;
  }

  /** Broadcast a message to every connected device (progress coalesced to 1s). */
  broadcast(msg: Record<string, unknown>): void {
    // High-frequency task progress (and screen:update/cursor relayed as hub
    // pushes) is coalesced per-task to 1s leading+trailing so a fast producer
    // can't spam every paired device. Terminal task states flush first to
    // preserve order (progress-before-done).
    const taskId = (msg as { task?: { id?: unknown } }).task?.id;
    const event = (msg as { event?: unknown }).event;
    const kind = (msg as { t?: unknown }).t;
    if (kind === 'task-event' && typeof taskId === 'string' && taskId) {
      if (event === 'task:progress') {
        this.broadcastProgressCoalesced(taskId, msg);
        return;
      }
      if (event === 'task:completed' || event === 'task:failed' || event === 'task:cancelled') {
        this.flushProgress(taskId);
      }
    }
    for (const ws of this.byDevice.values()) {
      if (ws.readyState === WebSocket.OPEN) this.sendJson(ws, { ...msg, from: 'hub' });
    }
  }

  private broadcastProgressCoalesced(taskId: string, msg: Record<string, unknown>): void {
    const now = Date.now();
    const last = this.progressLastAt.get(taskId) ?? 0;
    if (now - last >= this.COALESCE_MS) {
      this.progressLastAt.set(taskId, now);
      for (const ws of this.byDevice.values()) {
        if (ws.readyState === WebSocket.OPEN) this.sendJson(ws, { ...msg, from: 'hub' });
      }
      return;
    }
    const existing = this.progressPending.get(taskId);
    if (existing) {
      existing.msg = msg;
      return;
    }
    const delay = this.COALESCE_MS - (now - last);
    const timer = setTimeout(() => {
      this.progressPending.delete(taskId);
      this.progressLastAt.set(taskId, Date.now());
      for (const ws of this.byDevice.values()) {
        if (ws.readyState === WebSocket.OPEN) this.sendJson(ws, { ...msg, from: 'hub' });
      }
    }, Math.max(0, delay));
    try { (timer as unknown as { unref?: () => void }).unref?.(); } catch {}
    this.progressPending.set(taskId, { msg, timer });
  }

  private flushProgress(taskId: string): void {
    const pending = this.progressPending.get(taskId);
    if (!pending) return;
    this.progressPending.delete(taskId);
    try { clearTimeout(pending.timer); } catch {}
    this.progressLastAt.set(taskId, Date.now());
    for (const ws of this.byDevice.values()) {
      if (ws.readyState === WebSocket.OPEN) this.sendJson(ws, { ...pending.msg, from: 'hub' });
    }
  }

  /**
   * Send a message to a device and await its reply (correlated by reqId).
   * This is how the cloud hands a task to a connected desktop and learns the
   * task id, or how it asks any device to do work and waits for the result.
   */
  request(deviceId: string, msg: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const reqId = `h${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`Device ${deviceId} did not reply in time`));
      }, timeoutMs);
      this.pendingRequests.set(reqId, { resolve, reject, timer });
      const delivered = this.send(deviceId, { ...msg, reqId, from: 'hub' });
      if (!delivered) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        reject(new Error(`Device ${deviceId} is offline`));
      }
    });
  }

  isOnline(deviceId: string): boolean {
    const ws = this.byDevice.get(deviceId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  getAddress(): { port: number; address: string } | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (!addr || typeof addr === 'string') return null;
    return { port: addr.port, address: addr.address };
  }

  getStatus(): { connected: number; registered: number; onlineDevices: string[] } {
    return {
      connected: this.byDevice.size,
      registered: this.registry.listDevices().length,
      onlineDevices: [...this.byDevice.keys()],
    };
  }

  private handleMessage(ws: WebSocket, raw: RawData): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    conn.lastSeen = Date.now();

    // ── First message must be auth ───────────────────────────
    if (!conn.device) {
      this.handleAuth(ws, conn, parsed);
      return;
    }

    switch (parsed.t) {
      case 'ping':
        this.sendJson(ws, { t: 'pong', at: Date.now() });
        break;
      case 'relay':
        this.handleRelay(ws, conn.device, parsed);
        break;
      case 'list':
        this.sendJson(ws, {
          t: 'devices',
          devices: this.registry.listDevices().map(d => ({
            deviceId: d.deviceId,
            name: d.name,
            role: d.role,
            capabilities: d.capabilities,
            online: this.isOnline(d.deviceId),
          })),
        });
        break;
      case 'reply': {
        const reqId = String(parsed.reqId || '');
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(reqId);
          pending.resolve((parsed.msg as Record<string, unknown>) ?? parsed);
        }
        break;
      }
      default:
        this.sendJson(ws, { t: 'error', error: `Unknown type: ${parsed.t}` });
    }
  }

  private handleAuth(ws: WebSocket, conn: HubConnection, msg: Record<string, unknown>): void {
    const token = String(msg.token || '');
    const device = this.registry.authenticate(token);
    if (!device) {
      this.sendJson(ws, { t: 'auth-error', error: 'Invalid device token' });
      try { ws.close(); } catch { }
      return;
    }

    conn.device = device;
    this.registry.markSeen(device.deviceId);
    this.byDevice.set(device.deviceId, ws);

    this.sendJson(ws, { t: 'welcome', deviceId: device.deviceId, name: device.name, role: device.role });
    this.broadcastPresence(device.deviceId, true, ws);
    getLogger().info({ deviceId: device.deviceId, name: device.name }, 'Device authenticated');
  }

  private handleRelay(ws: WebSocket, from: RegisteredDevice, msg: Record<string, unknown>): void {
    const to = String(msg.to || '');
    const target = this.byDevice.get(to);
    if (!target || target.readyState !== WebSocket.OPEN) {
      this.sendJson(ws, { t: 'relay-error', to, error: 'Device offline' });
      return;
    }
    this.sendJson(target, { t: 'relay', from: from.deviceId, msg: msg.msg ?? {} });
  }

  private onDisconnect(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    this.connections.delete(ws);
    if (conn?.device) {
      const deviceId = conn.device.deviceId;
      if (this.byDevice.get(deviceId) === ws) this.byDevice.delete(deviceId);
      this.broadcastPresence(deviceId, false, ws);
      getLogger().info({ deviceId }, 'Device disconnected');
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ws, conn] of this.connections) {
      if (now - conn.lastSeen > this.heartbeatTimeoutMs) {
        getLogger().warn({ deviceId: conn.device?.deviceId }, 'Device heartbeat timeout — closing connection');
        try { ws.terminate(); } catch { }
        this.onDisconnect(ws);
      }
    }
  }

  private broadcastPresence(deviceId: string, online: boolean, except?: WebSocket): void {
    // Pairing spam guard: a flapping device re-authing within 1s with the SAME
    // state is a duplicate — drop it (or coalesce to one trailing send).
    // A state FLIP (online→offline) always sends immediately.
    const now = Date.now();
    const last = this.presenceLastSent.get(deviceId);
    if (last && last.online === online && now - last.at < this.COALESCE_MS) {
      const pending = this.presencePending.get(deviceId);
      if (pending) return; // trailing already scheduled
      const delay = this.COALESCE_MS - (now - last.at);
      const timer = setTimeout(() => {
        this.presencePending.delete(deviceId);
        this.presenceLastSent.set(deviceId, { online, at: Date.now() });
        this.sendPresence(deviceId, online, except);
      }, Math.max(0, delay));
      try { (timer as unknown as { unref?: () => void }).unref?.(); } catch {}
      this.presencePending.set(deviceId, { online, timer });
      return;
    }
    const pending = this.presencePending.get(deviceId);
    if (pending) {
      try { clearTimeout(pending.timer); } catch {}
      this.presencePending.delete(deviceId);
    }
    this.presenceLastSent.set(deviceId, { online, at: now });
    this.sendPresence(deviceId, online, except);
  }

  private sendPresence(deviceId: string, online: boolean, except?: WebSocket): void {
    for (const [ws, conn] of this.connections) {
      if (ws === except || !conn.device) continue;
      this.sendJson(ws, { t: 'presence', deviceId, online });
    }
  }

  private sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch { }
  }
}
