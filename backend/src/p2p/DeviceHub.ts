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

  /** Broadcast a message to every connected device. */
  broadcast(msg: Record<string, unknown>): void {
    for (const ws of this.byDevice.values()) {
      if (ws.readyState === WebSocket.OPEN) this.sendJson(ws, { ...msg, from: 'hub' });
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
