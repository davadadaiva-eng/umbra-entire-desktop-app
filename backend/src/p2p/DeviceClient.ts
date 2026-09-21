import WebSocket from 'ws';
import { DeviceRole } from './DeviceRegistry';
import { getLogger } from '../core/Logger';

export interface DeviceClientOptions {
  /** ws://host:port/device-ws — the hub endpoint. */
  url: string;
  token: string;
  deviceId?: string;
  name: string;
  role: DeviceRole;
  capabilities?: string[];
  onMessage?: (from: string, msg: Record<string, unknown>) => void;
  onPresence?: (deviceId: string, online: boolean) => void;
  onStatus?: (connected: boolean) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * DeviceClient — the half of the mesh that lives on each device.
 *
 * Connects to the DeviceHub with its long-lived token and, on any drop,
 * reconnects with exponential backoff. Combined with the hub's persisted
 * registry, this is what keeps a device "always connected" — it survives
 * network blips, hub restarts, and the device itself rebooting.
 */
export class DeviceClient {
  private options: DeviceClientOptions;
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: DeviceClientOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      try { this.ws.close(); } catch { }
      this.ws = null;
    }
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Send a raw message to the hub. */
  send(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(msg)); } catch { }
  }

  /** Relay a message through the hub to another device. */
  relay(to: string, msg: Record<string, unknown>): void {
    this.send({ t: 'relay', to, msg });
  }

  /** Reply to a hub request (correlated by the reqId the hub sent). */
  reply(reqId: string, msg: Record<string, unknown>): void {
    this.send({ t: 'reply', reqId, msg });
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.on('open', () => {
      this.send({
        t: 'auth',
        token: this.options.token,
        deviceId: this.options.deviceId,
        name: this.options.name,
        role: this.options.role,
        capabilities: this.options.capabilities ?? [],
      });
    });

    ws.on('message', raw => this.onMessage(raw.toString()));
    ws.on('close', () => this.onDrop());
    ws.on('error', () => this.onDrop());
  }

  private onMessage(text: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (parsed.t === 'welcome') {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.options.onStatus?.(true);
      this.startHeartbeat();
      getLogger().info({ deviceId: this.options.deviceId }, 'DeviceClient connected to hub');
      return;
    }
    if (parsed.t === 'auth-error') {
      getLogger().warn({ error: parsed.error }, 'DeviceClient auth rejected');
      // Do not retry a bad token forever — stop and surface the error.
      this.stopped = true;
      this.options.onStatus?.(false);
      try { this.ws?.close(); } catch { }
      return;
    }
    if (parsed.t === 'pong') return;
    if (parsed.t === 'presence') {
      this.options.onPresence?.(String(parsed.deviceId || ''), parsed.online === true);
      return;
    }
    if (parsed.t === 'relay') {
      this.options.onMessage?.(String(parsed.from || ''), (parsed.msg as Record<string, unknown>) ?? {});
      return;
    }
    // Any other message is a hub-direct push to this device.
    this.options.onMessage?.(String(parsed.from || 'hub'), parsed);
  }

  private onDrop(): void {
    this.connected = false;
    this.clearTimers();
    this.options.onStatus?.(false);
    if (this.stopped) return;

    const base = this.options.reconnectBaseMs ?? 1000;
    const max = this.options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts), max);
    this.reconnectAttempts++;
    getLogger().info({ delayMs: delay, attempt: this.reconnectAttempts }, 'DeviceClient reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const interval = this.options.heartbeatIntervalMs ?? 20_000;
    this.heartbeatTimer = setInterval(() => this.send({ t: 'ping', at: Date.now() }), interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearHeartbeat();
  }
}
