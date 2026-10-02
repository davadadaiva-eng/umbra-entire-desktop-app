/**
 * CdpSession — one long-lived Chrome DevTools Protocol connection to a single
 * page target.
 *
 * `BrowserManager` models a "current tab" and tears down its socket on every
 * `activateTab()`, which is fine for interactive driving but wrong for a 60fps
 * render loop that must hold several independent pages open at once. This is a
 * deliberately small, self-contained alternative: one socket per page, no
 * shared mutable "active" state, timeouts on every call.
 */

import WebSocket from 'ws';

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface PendingCall {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_CALL_TIMEOUT_MS = 10000;

export class CdpSession {
  private ws: WebSocket | null = null;
  private pending = new Map<number, PendingCall>();
  private msgId = 0;
  private connecting: Promise<void> | null = null;

  constructor(
    public readonly targetId: string,
    private readonly wsUrl: string,
    private readonly callTimeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
  ) {}

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws = ws;

      // Closing/terminating a CONNECTING socket makes `ws` abort the handshake
      // and emit 'error' — via process.nextTick (ws 8.x abortHandshake), i.e.
      // after the try/catch below and after cleanup() removed onError. An
      // 'error' event with no listener escalates to uncaughtException and
      // kills the process, so a no-op listener stays attached for the
      // socket's whole life; onError (below) handles the connect phase.
      const swallow = (): void => {};
      ws.on('error', swallow);

      const timer = setTimeout(() => {
        cleanup();
        try { ws.terminate(); } catch { /* already closed */ }
        if (this.ws === ws) this.ws = null;
        reject(new Error(`CDP connect timeout after ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);

      const onOpen = (): void => { cleanup(); resolve(); };
      const onError = (e: Error): void => { cleanup(); reject(e); };
      const cleanup = (): void => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onError);
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
    }).finally(() => { this.connecting = null; });

    return this.connecting;
  }

  /** Attach message routing. Only safe to call once, after connect() resolves. */
  listen(): void {
    const ws = this.ws;
    if (!ws) throw new Error('CdpSession.listen() before connect()');
    if ((ws as any).__umbraListening) return;
    (ws as any).__umbraListening = true;

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const call = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) call.reject(new Error(msg.error.message || 'CDP error'));
      else call.resolve(msg.result);
    });

    ws.on('close', () => {
      this.failPending(new Error('CDP connection closed'));
      this.ws = null;
    });

    ws.on('error', () => {
      // The 'close' handler performs the cleanup; swallowing keeps the process
      // from crashing on a transient socket error.
      this.failPending(new Error('CDP socket error'));
    });
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP session ${this.targetId} is not connected`);
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  close(): void {
    this.failPending(new Error('CDP session closed'));
    if (this.ws) {
      // Safe in any readyState: connect() keeps a no-op 'error' listener
      // attached, so the handshake-abort emission from closing a CONNECTING
      // socket is handled instead of crashing the process on the next tick.
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
  }

  private failPending(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    this.pending.clear();
  }
}
