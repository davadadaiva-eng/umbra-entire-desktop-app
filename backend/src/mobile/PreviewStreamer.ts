import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server } from 'http';
import { getLogger } from '../core/Logger';

export interface StreamConfig {
  enabled: boolean;
  port: number;
  fps: number;
}

export type FrameProvider = () => Promise<Buffer | null>;
export type CommandHandler = (action: string, params: Record<string, unknown>) => Promise<string>;

interface StreamClient {
  ws: WebSocket;
  subscribed: boolean;
}

export class PreviewStreamer {
  private config: StreamConfig;
  private frameProvider: FrameProvider | null = null;
  private commandHandler: CommandHandler | null = null;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<StreamClient>();
  private streamTimer: NodeJS.Timeout | null = null;
  private streamActive: boolean = false;

  constructor(config?: Partial<StreamConfig>) {
    this.config = {
      enabled: true,
      port: 9090,
      fps: 5,
      ...config,
    };
  }

  setFrameProvider(provider: FrameProvider | null): void {
    this.frameProvider = provider;
  }

  setCommandHandler(handler: CommandHandler | null): void {
    this.commandHandler = handler;
  }

  start(): void {
    if (!this.config.enabled || this.httpServer) return;

    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', ws => {
      const client: StreamClient = { ws, subscribed: false };
      this.clients.add(client);
      getLogger().info(`Preview stream client connected (${this.clients.size} total)`);

      ws.on('message', async (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        await this.handleMessage(client, msg);
      });

      ws.on('close', () => {
        this.clients.delete(client);
        getLogger().info(`Preview stream client disconnected (${this.clients.size} total)`);
        if (this.clients.size === 0) this.stopFrameLoop();
      });

      ws.on('error', () => {
        this.clients.delete(client);
        if (this.clients.size === 0) this.stopFrameLoop();
      });
    });

    this.httpServer.listen(this.config.port, () => {
      getLogger().info({ port: this.config.port }, 'Preview stream server listening');
    });
  }

  stop(): void {
    this.stopFrameLoop();
    if (this.wss) {
      for (const client of this.clients) {
        try { client.ws.close(); } catch { }
      }
      this.clients.clear();
      try { this.wss.close(); } catch { }
      this.wss = null;
    }
    if (this.httpServer) {
      try { this.httpServer.close(); } catch { }
      this.httpServer = null;
    }
    getLogger().info('Preview stream server stopped');
  }

  getStreamStatus(): { active: boolean; clients: number; fps: number; port: number } {
    return {
      active: this.streamActive,
      clients: this.clients.size,
      fps: this.config.fps,
      port: this.config.port,
    };
  }

  private async handleMessage(client: StreamClient, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type || '');
    switch (type) {
      case 'subscribe':
        client.subscribed = true;
        this.ensureFrameLoop();
        this.send(client, { type: 'subscribed', fps: this.config.fps });
        break;

      case 'unsubscribe':
        client.subscribed = false;
        break;

      case 'screenshot':
        const buf = await this.captureFrame();
        if (buf) {
          this.send(client, { type: 'screenshot', image: buf.toString('base64'), at: Date.now() });
        } else {
          this.send(client, { type: 'screenshot', image: null, at: Date.now() });
        }
        break;

      case 'command':
        if (!this.commandHandler) {
          this.send(client, { type: 'error', action: msg.action, error: 'No command handler' });
          break;
        }
        try {
          const result = await this.commandHandler(String(msg.action || ''), (msg.params || {}) as Record<string, unknown>);
          this.send(client, { type: 'result', action: msg.action, result });
        } catch (e) {
          this.send(client, { type: 'error', action: msg.action, error: (e as Error).message });
        }
        break;

      case 'ping':
        this.send(client, { type: 'pong', at: Date.now() });
        break;

      case 'status':
        this.send(client, { type: 'status', status: this.getStreamStatus() });
        break;

      default:
        break;
    }
  }

  private ensureFrameLoop(): void {
    if (this.streamTimer || this.clients.size === 0) return;
    this.streamActive = true;
    this.streamTimer = setInterval(() => {
      this.pushFrame().catch(() => { });
    }, 1000 / this.config.fps);
  }

  private stopFrameLoop(): void {
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    this.streamActive = false;
  }

  private async pushFrame(): Promise<void> {
    const subscribers = [...this.clients].filter(c => c.subscribed);
    if (subscribers.length === 0) return;
    const buf = await this.captureFrame();
    if (!buf) return;
    const image = buf.toString('base64');
    for (const client of subscribers) {
      this.send(client, { type: 'frame', image, at: Date.now() });
    }
  }

  private async captureFrame(): Promise<Buffer | null> {
    if (!this.frameProvider) return null;
    try {
      return await this.frameProvider();
    } catch {
      return null;
    }
  }

  private send(client: StreamClient, msg: Record<string, unknown>): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(msg));
      } catch { }
    }
  }
}
