import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createServer, Server } from 'http';
import { PairingManager } from './PairingManager';
import { EncryptedChannel, EncryptedMessage } from './crypto/EncryptedChannel';
import { WebRTCConfig, SignalingMessage } from './webrtc/WebRTCConfig';
import { getLogger } from '../core/Logger';

export type P2PCommandHandler = (action: string, params: Record<string, unknown>, deviceId: string) => Promise<string>;
export type P2PFrameProvider = () => Promise<Buffer | null>;

export interface P2PConnectionManagerOptions {
  signalingPort: number;
  stunServers: string[];
  turnServers?: string[];
  relayFps: number;
  pairing: PairingManager;
  commandHandler?: P2PCommandHandler | null;
  frameProvider?: P2PFrameProvider | null;
  webrtcConfig?: WebRTCConfig | null;
}

interface P2PClient {
  ws: WebSocket;
  deviceId: string | null;
  channel: EncryptedChannel | null;
  subscribed: boolean;
  remoteAddress?: string;
}

/**
 * P2PConnectionManager — the phone-control signaling hub.
 *
 * All traffic flows over the loopback/public WebSocket server:
 *   1. Encrypted QR pairing (ECDH → AES-256-GCM).
 *   2. WebRTC signaling relay (SDP + ICE) so the PWA can negotiate a direct
 *      peer-to-peer RTCDataChannel / media stream via public STUN servers.
 *   3. Encrypted fallback relay: command channel + compressed JPEG frames
 *      when the WebRTC media backend is unavailable.
 * Zero central routing: after pairing, nothing is proxied through a third
 * party — the phone talks straight to this PC.
 */
export class P2PConnectionManager {
  private options: P2PConnectionManagerOptions;
  private pairing: PairingManager;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<P2PClient>();
  private frameTimer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(options: P2PConnectionManagerOptions) {
    this.options = options;
    this.pairing = options.pairing;
  }

  setCommandHandler(handler: P2PCommandHandler | null): void {
    this.options.commandHandler = handler;
  }

  setFrameProvider(provider: P2PFrameProvider | null): void {
    this.options.frameProvider = provider;
  }

  start(): void {
    if (this.httpServer) return;
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      const client: P2PClient = {
        ws,
        deviceId: null,
        channel: null,
        subscribed: false,
        remoteAddress: req.socket.remoteAddress,
      };
      this.clients.add(client);
      getLogger().info({ remote: client.remoteAddress }, 'P2P client connected');

      ws.on('message', raw => this.handleMessage(client, raw));
      ws.on('close', () => {
        this.clients.delete(client);
        if (this.clients.size === 0) this.stopFrameLoop();
      });
      ws.on('error', () => {
        this.clients.delete(client);
        if (this.clients.size === 0) this.stopFrameLoop();
      });
    });

    this.httpServer.listen(this.options.signalingPort, () => {
      this.active = true;
      getLogger().info({ port: this.options.signalingPort }, 'P2P signaling server listening');
    });
  }

  stop(): void {
    this.stopFrameLoop();
    this.active = false;
    if (this.wss) {
      for (const c of this.clients) {
        try { c.ws.close(); } catch { }
      }
      this.clients.clear();
      try { this.wss.close(); } catch { }
      this.wss = null;
    }
    if (this.httpServer) {
      try { this.httpServer.close(); } catch { }
      this.httpServer = null;
    }
    getLogger().info('P2P signaling server stopped');
  }

  getStatus(): { active: boolean; clients: number; pairedDevices: number; stunServers: string[]; turnServers: string[] } {
    return {
      active: this.active,
      clients: this.clients.size,
      pairedDevices: this.pairing.listDevices().length,
      stunServers: this.options.stunServers,
      turnServers: this.options.turnServers ?? [],
    };
  }

  getAddress(): { port: number; address: string } | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (!addr || typeof addr === 'string') return null;
    return { port: addr.port, address: addr.address };
  }

  private async handleMessage(client: P2PClient, raw: RawData): Promise<void> {
    try {
      const text = raw.toString();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      // ── Handshake (plaintext, once) ──────────────────────────
      if (parsed.type === 'pair' && !client.channel) {
        this.handlePairing(client, parsed);
        return;
      }
      if (parsed.type === 'hello') {
        if (client.channel && client.deviceId) {
          // Socket already paired in the 'pair' step — confirm welcome.
          this.pairing.touch(client.deviceId);
          this.sendWelcome(client);
          return;
        }
        const deviceId = String(parsed.deviceId || '');
        const channel = this.pairing.openChannel(deviceId);
        if (!channel) {
          this.sendJson(client, { type: 'error', error: 'Device not paired' });
          return;
        }
        client.deviceId = deviceId;
        client.channel = channel;
        this.pairing.touch(deviceId);
        this.sendWelcome(client);
        return;
      }

      // ── Everything else must be encrypted ────────────────────
      if (!client.channel) {
        this.sendJson(client, { type: 'error', error: 'Not paired' });
        return;
      }
      await this.handleEncrypted(client, parsed);
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'P2P message handling failed');
    }
  }

  private sendWelcome(client: P2PClient): void {
    this.sendJson(client, {
      type: 'welcome',
      server: 'umbra-p2p',
      relayFps: this.options.relayFps,
      webrtc: !!this.options.webrtcConfig?.enabled,
      stunServers: this.options.stunServers,
      turnServers: this.options.turnServers ?? [],
    });
  }

  private handlePairing(client: P2PClient, msg: Record<string, unknown>): void {
    try {
      const result = this.pairing.completePairing({
        sessionId: String(msg.sessionId || ''),
        name: String(msg.name || 'Phone'),
        devicePublicKeyPem: String(msg.devicePublicKeyPem || ''),
      });
      client.deviceId = result.deviceId;
      client.channel = result.channel;
      this.sendJson(client, { type: 'paired', deviceId: result.deviceId, name: (msg.name as string) || 'Phone' });
      getLogger().info({ deviceId: result.deviceId }, 'P2P device completed pairing');
    } catch (err: any) {
      this.sendJson(client, { type: 'pair-failed', error: err.message });
    }
  }

  private async handleEncrypted(client: P2PClient, parsed: Record<string, unknown>): Promise<void> {
    const channel = client.channel!;
    const envelope = EncryptedChannel.fromWire(JSON.stringify(parsed.enc) as any);
    const inner = channel.decryptJson<{ t: string; [k: string]: unknown }>(envelope);

    switch (inner.t) {
      case 'cmd':
        await this.handleCommand(client, inner);
        break;
      case 'frame':
        await this.handleFrameRequest(client);
        break;
      case 'subscribe':
        client.subscribed = true;
        this.ensureFrameLoop();
        this.sendEnc(client, { t: 'subscribed', fps: this.options.relayFps });
        break;
      case 'unsubscribe':
        client.subscribed = false;
        break;
      case 'ping':
        this.sendEnc(client, { t: 'pong', at: Date.now() });
        break;
      case 'status':
        this.sendEnc(client, { t: 'status', status: this.getStatus() });
        break;
      case 'webrtc-signal':
        this.handleWebRtcSignal(client, inner.signal as SignalingMessage);
        break;
      case 'telemetry':
        getLogger().debug({ deviceId: client.deviceId, ...inner }, 'P2P telemetry');
        break;
      default:
        this.sendEnc(client, { t: 'error', error: `Unknown type: ${inner.t}` });
    }
  }

  private async handleCommand(client: P2PClient, msg: Record<string, unknown>): Promise<void> {
    const action = String(msg.action || '');
    const params = (msg.params || {}) as Record<string, unknown>;
    const reqId = String(msg.reqId || '');

    if (!this.options.commandHandler) {
      this.sendEnc(client, { t: 'result', reqId, ok: false, error: 'No command handler' });
      return;
    }
    try {
      const result = await this.options.commandHandler(action, params, client.deviceId || '');
      this.sendEnc(client, { t: 'result', reqId, ok: true, result });
    } catch (err: any) {
      this.sendEnc(client, { t: 'result', reqId, ok: false, error: err.message });
    }
  }

  private async handleFrameRequest(client: P2PClient): Promise<void> {
    const buf = await this.captureFrame();
    if (!buf) {
      this.sendEnc(client, { t: 'frame', image: null, at: Date.now() });
      return;
    }
    this.sendEnc(client, { t: 'frame', image: buf.toString('base64'), at: Date.now() });
  }

  private handleWebRtcSignal(client: P2PClient, signal: SignalingMessage): void {
    if (!this.options.webrtcConfig || !this.options.webrtcConfig.enabled) {
      this.sendEnc(client, { t: 'webrtc-unavailable', reason: 'WebRTC media backend not installed' });
      return;
    }
    // Forward to the pluggable Node WebRTC backend (e.g. werift). The
    // backend answers with the negotiated stream; until then clients use
    // the encrypted JPEG relay automatically.
    try {
      const answer = this.options.webrtcConfig.onSignal(signal, client.deviceId || '');
      if (answer) this.sendEnc(client, { t: 'webrtc-signal', signal: answer });
    } catch (err: any) {
      this.sendEnc(client, { t: 'webrtc-unavailable', reason: err.message });
    }
  }

  private ensureFrameLoop(): void {
    if (this.frameTimer) return;
    this.frameTimer = setInterval(() => {
      this.pushFrameToSubscribers().catch(() => { });
    }, Math.max(1000 / Math.max(1, this.options.relayFps), 50));
  }

  private stopFrameLoop(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  private async pushFrameToSubscribers(): Promise<void> {
    const subscribers = [...this.clients].filter(c => c.subscribed && c.channel);
    if (subscribers.length === 0) return;
    const buf = await this.captureFrame();
    if (!buf) return;
    const image = buf.toString('base64');
    for (const client of subscribers) {
      this.sendEnc(client, { t: 'frame', image, at: Date.now() });
    }
  }

  private async captureFrame(): Promise<Buffer | null> {
    if (!this.options.frameProvider) return null;
    try {
      return await this.options.frameProvider();
    } catch {
      return null;
    }
  }

  private sendEnc(client: P2PClient, payload: Record<string, unknown>): void {
    if (!client.channel || client.ws.readyState !== WebSocket.OPEN) return;
    try {
      const enc = client.channel.encrypt(payload);
      client.ws.send(JSON.stringify({ type: 'enc', enc }));
    } catch { }
  }

  private sendJson(client: P2PClient, msg: Record<string, unknown>): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(msg));
      } catch { }
    }
  }
}

export { EncryptedChannel };
export type { EncryptedMessage };
