import { createServer, Server } from 'http';
import * as url from 'url';
import QRCode from 'qrcode';
import { PairingManager, PairingPayload } from '../p2p/PairingManager';
import { getLogger } from '../core/Logger';
import { TenantLedger } from '../core/billing/TenantLedger';
import { pwaHtml } from './pwa/indexHtml';

export interface PwaServerOptions {
  webPort: number;
  signalingPort: number;
  pairing: PairingManager;
  getStatus: () => { active: boolean; clients: number; pairedDevices: number };
  /**
   * "Ask Umbra" handler — runs the task on a real agent (cloud or local model)
   * instead of a stub. Returns where the task was dispatched and its id.
   */
  onChat?: (message: string, target?: string) => Promise<{ taskId: string; target: string }>;
  /** Active-task list for the PWA task dashboard (wire to AgentRuntime.getActiveTasks). */
  getActiveTasks?: () => unknown;
  /** Single-task lookup for the PWA task dashboard (wire to AgentRuntime.getTask). */
  getTask?: (id: string) => unknown;
  /** Cancel an in-flight task (wire to AgentRuntime.cancelTask). */
  onCancelTask?: (taskId: string) => Promise<unknown>;
  /** Retry a failed/cancelled task (wire to AgentRuntime.retryTask). */
  onRetryTask?: (taskId: string, description?: string) => Promise<unknown>;
  /** Device-mesh overview for the PWA (plan device limit + registered devices). */
  getDeviceInfo?: () => unknown;
  /** Voice/push-to-talk state for the PWA settings card (enabled/combo/capturing/micOk). */
  getPushToTalkStatus?: () => unknown;
  /** Persist + (re)arm the push-to-talk hotkey from the phone (combo, enabled). */
  onSetPushToTalk?: (combo: string, enabled?: boolean) => Promise<unknown>;
}

/**
 * PwaServer — serves the secure Progressive Web App for smartphone control.
 *
 * Routes:
 *   GET  /               → the PWA (pairing + live control)
 *   GET  /pair           → QR pairing page (rendered server-side with qrcode)
 *   POST /api/pairing    → fresh pairing payload (JSON)
 *   GET  /health         → status
 *
 * The app and all state live on the PC; the phone only renders what the PC
 * streams. No data transits any central server.
 */
export class PwaServer {
  private options: PwaServerOptions;
  private server: Server | null = null;

  constructor(options: PwaServerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.server) return;
    this.server = createServer((req, res) => this.route(req, res));
    this.server.listen(this.options.webPort, () => {
      getLogger().info({ port: this.options.webPort }, 'PWA server listening');
    });
  }

  stop(): void {
    if (this.server) {
      try { this.server.close(); } catch { }
      this.server = null;
    }
  }

  private route(req: import('http').IncomingMessage, res: import('http').ServerResponse): void {
    const parsed = url.parse(req.url || '/', true);

    if (req.method === 'POST' && parsed.pathname === '/api/pairing') {
      const payload = this.newPayload();
      this.json(res, 200, { payload, expiresInMs: payload.expiresAt - Date.now() });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/chat') {
      this.handleChat(req, res);
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/tasks') {
      this.json(res, 200, { tasks: this.options.getActiveTasks ? this.options.getActiveTasks() : [] });
      return;
    }

    // Same-origin device-mesh info for the PWA "Plan & devices" card
    // (plan device limit + registered devices + online status).
    if (req.method === 'GET' && parsed.pathname === '/api/devices') {
      this.json(res, 200, { devices: this.options.getDeviceInfo ? this.options.getDeviceInfo() : null });
      return;
    }

    // Voice/push-to-talk state + toggle for the PWA settings card.
    if (req.method === 'GET' && parsed.pathname === '/api/voice/ptt') {
      this.json(res, 200, { pushToTalk: this.options.getPushToTalkStatus ? this.options.getPushToTalkStatus() : null });
      return;
    }
    if (req.method === 'POST' && parsed.pathname === '/api/voice/ptt') {
      this.handleSetPushToTalk(req, res);
      return;
    }

    const taskMatch = (parsed.pathname || '').match(/^\/api\/task\/([\w-]+)$/);
    if (req.method === 'GET' && taskMatch && this.options.getTask) {
      const task = this.options.getTask(taskMatch[1]);
      if (!task) {
        this.json(res, 404, { error: 'Task not found' });
        return;
      }
      this.json(res, 200, { task });
      return;
    }

    // Cancel an in-flight task. The PWA asks the PC for a consent grant first
    // (POST /api/consent), then cancels via this route on the executing node.
    const cancelMatch = (parsed.pathname || '').match(/^\/api\/task\/([\w-]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      if (this.options.onCancelTask) {
        this.options
          .onCancelTask(cancelMatch[1])
          .then(() => this.json(res, 200, { cancelled: cancelMatch[1] }))
          .catch((err: any) => this.json(res, 500, { error: err?.message || 'Cancel failed' }));
      } else {
        this.json(res, 501, { error: 'cancelTask is not available on this node' });
      }
      return;
    }

    // Retry a failed/cancelled task (consent-gated, same as cancel).
    const retryMatch = (parsed.pathname || '').match(/^\/api\/task\/([\w-]+)\/retry$/);
    if (req.method === 'POST' && retryMatch) {
      if (this.options.onRetryTask) {
        this.options
          .onRetryTask(retryMatch[1])
          .then(() => this.json(res, 200, { retried: retryMatch[1] }))
          .catch((err: any) => this.json(res, 500, { error: err?.message || 'Retry failed' }));
      } else {
        this.json(res, 501, { error: 'retryTask is not available on this node' });
      }
      return;
    }

    switch (parsed.pathname) {
      case '/':
      case '/index.html':
        this.html(res, pwaHtml);
        break;
      case '/pair':
        this.pairPage()
          .then(page => this.html(res, page))
          .catch(() => this.html(res, '<h1>QR generation failed — retry</h1>'));
        break;
      case '/health':
        this.json(res, 200, { ok: true, ...this.options.getStatus() });
        break;
      default:
        this.json(res, 404, { error: 'Not found' });
    }
  }

  private async handleChat(req: import('http').IncomingMessage, res: import('http').ServerResponse): Promise<void> {
    if (!this.options.onChat) {
      this.json(res, 501, { error: 'Agent not configured — no onChat handler' });
      return;
    }
    let body: { message?: string; target?: string } = {};
    try {
      body = await this.readJson(req);
    } catch {
      this.json(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const message = (body.message || '').trim();
    if (!message) {
      this.json(res, 400, { error: 'message is required' });
      return;
    }
    try {
      // Same multi-tenant binding as the main API: X-Umbra-Tenant scopes this
      // chat's LLM spend to that tenant's budget.
      const tenantId = String(req.headers['x-umbra-tenant'] || '').trim() || undefined;
      const dispatch = await TenantLedger.run(tenantId, () => this.options.onChat!(message, body.target || 'auto'));
      this.json(res, 200, { dispatch });
    } catch (err: any) {
      this.json(res, 500, { error: err.message || 'Task dispatch failed' });
    }
  }

  private async handleSetPushToTalk(req: import('http').IncomingMessage, res: import('http').ServerResponse): Promise<void> {
    if (!this.options.onSetPushToTalk) {
      this.json(res, 501, { error: 'Push-to-talk control is not available on this node' });
      return;
    }
    let body: { combo?: string; enabled?: boolean } = {};
    try {
      body = await this.readJson(req);
    } catch {
      this.json(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const combo = String(body.combo || '').trim();
    try {
      const state = await this.options.onSetPushToTalk(combo, body.enabled !== false);
      this.json(res, 200, { pushToTalk: state });
    } catch (err: any) {
      this.json(res, 500, { error: err.message || 'Could not update push-to-talk' });
    }
  }

  private readJson(req: import('http').IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private newPayload(): PairingPayload {
    return this.options.pairing.createSession(this.lanHost(), this.options.signalingPort);
  }

  private lanHost(): string {
    const candidates = this.localAddresses();
    return candidates[0] || 'localhost';
  }

  private localAddresses(): string[] {
    try {
      const nets = require('os').networkInterfaces();
      const out: string[] = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) out.push(net.address);
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async pairPage(): Promise<string> {
    const payload = this.newPayload();
    let qrImg = '';
    try {
      qrImg = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', width: 512 });
    } catch {
      qrImg = '';
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pair Umbra OS</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1117;color:#e6e6e6;display:flex;flex-direction:column;align-items:center;gap:16px;padding:40px}h1{font-size:20px}code{background:#1c1f27;padding:8px 12px;border-radius:6px;word-break:break-all;max-width:640px}</style></head>
<body><h1>Scan this QR with the Umbra phone app</h1>${qrImg ? `<img src="${qrImg}" alt="pairing QR" width="300"/>` : ''}
<details><summary>Raw pairing payload</summary><code>${JSON.stringify(payload)}</code></details></body></html>`;
  }

  private html(res: import('http').ServerResponse, body: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  private json(res: import('http').ServerResponse, code: number, body: Record<string, unknown>): void {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
}
