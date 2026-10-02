/**
 * CdpSession tests.
 *
 * The renderer holds one CDP socket per virtual display and retries in the
 * background while Chrome is down, so every failed connect must clean up
 * without crashing the process. The classic failure: closing a CONNECTING
 * socket makes `ws` abort the handshake and emit 'error' via
 * process.nextTick — after the session's try/catch and after its cleanup
 * removed the connect-phase listener. An 'error' event with no listener
 * escalates to uncaughtException (the "WebSocket was closed before the
 * connection was established" crashes). These tests fail a connect in the
 * ways Chrome actually goes missing and assert the process survives.
 */

import * as net from 'net';
import { WebSocketServer } from 'ws';
import { CdpSession } from './CdpSession';

// ─── Fixtures ────────────────────────────────────────────────

/** Record uncaughtExceptions (the old code's crash) without failing early. */
function captureUncaught(): { seen: Error[]; done: () => void } {
  const seen: Error[] = [];
  const handler = (e: Error): void => { seen.push(e); };
  process.on('uncaughtException', handler);
  return { seen, done: () => process.off('uncaughtException', handler) };
}

/** Flush `ws`'s next-tick error emissions before asserting. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A TCP server that accepts sockets and never completes the HTTP upgrade,
 *  so a WebSocket client stays CONNECTING until its own timeout fires. */
async function hangingServer(): Promise<{ server: net.Server; port: number; destroy: () => void }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => { /* client went away — expected */ });
    socket.on('close', () => sockets.delete(socket));
    // No response: the upgrade request hangs forever.
  });
  const port = await new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  return {
    server,
    port,
    destroy: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('CdpSession failure paths', () => {
  it('rejects a hung handshake with its timeout error and never throws uncaughtException', async () => {
    const { port, destroy } = await hangingServer();
    const cap = captureUncaught();
    try {
      const session = new CdpSession('display-1', `ws://127.0.0.1:${port}`, 100);
      await expect(session.connect()).rejects.toThrow(/CDP connect timeout after 100ms/);
      await settle();
      expect(cap.seen).toEqual([]);
      expect(session.isOpen).toBe(false);
      // The failed attempt must leave the session reusable (state reset).
      await expect(session.connect()).rejects.toThrow(/CDP connect timeout/);
      await settle();
      expect(cap.seen).toEqual([]);
    } finally {
      cap.done();
      destroy();
    }
  });

  it('survives close() called while the socket is still connecting', async () => {
    const { port, destroy } = await hangingServer();
    const cap = captureUncaught();
    try {
      const session = new CdpSession('display-2', `ws://127.0.0.1:${port}`, 5000);
      const pending = session.connect();
      session.close();
      await expect(pending).rejects.toThrow(/closed before the connection was established/);
      await settle();
      expect(cap.seen).toEqual([]);
      expect(session.isOpen).toBe(false);
    } finally {
      cap.done();
      destroy();
    }
  });
});

describe('CdpSession happy path', () => {
  it('connects to a live CDP endpoint, listens, and closes cleanly', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => wss.once('listening', () => resolve()));
    const port = (wss.address() as net.AddressInfo).port;
    const cap = captureUncaught();
    try {
      const session = new CdpSession('display-3', `ws://127.0.0.1:${port}`, 2000);
      await session.connect();
      expect(session.isOpen).toBe(true);
      expect(() => session.listen()).not.toThrow();
      session.close();
      expect(session.isOpen).toBe(false);
      await settle();
      expect(cap.seen).toEqual([]);
    } finally {
      cap.done();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    }
  });

  it('rejects call() while not connected', async () => {
    const session = new CdpSession('display-4', 'ws://127.0.0.1:1', 50);
    await expect(session.call('Page.navigate')).rejects.toThrow(/not connected/);
  });
});
