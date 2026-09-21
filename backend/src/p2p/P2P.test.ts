import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import WebSocket from 'ws';
import { PairingManager } from './PairingManager';
import { EncryptedChannel, EncryptedMessage } from './crypto/EncryptedChannel';
import { P2PConnectionManager } from './P2PConnectionManager';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `umbra-p2p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

describe('EncryptedChannel', () => {
  it('round-trips encrypted payloads', () => {
    const shared = Buffer.from('0123456789abcdef0123456789abcdef');
    const ch = new EncryptedChannel(shared);
    const msg = ch.encrypt({ hello: 'world', n: 42 });
    const out = ch.decryptJson<{ hello: string; n: number }>(msg);
    expect(out.hello).toBe('world');
    expect(out.n).toBe(42);
  });

  it('rejects tampered ciphertext', () => {
    const shared = Buffer.from('0123456789abcdef0123456789abcdef');
    const ch = new EncryptedChannel(shared);
    const msg = ch.encrypt('secret');
    const dataBuf = Buffer.from(msg.data as string, 'base64');
    const flipped = Buffer.from(dataBuf);
    flipped[0] = flipped[0] ^ 0xff;
    const tampered: EncryptedMessage = { ...msg, data: flipped.toString('base64') };
    expect(() => ch.decrypt(tampered)).toThrow();
  });

  it('derives identical secrets via ECDH on both ends', () => {
    const a = EncryptedChannel.generateKeyPair();
    const b = EncryptedChannel.generateKeyPair();
    const secretA = EncryptedChannel.deriveSharedSecret(a.privateKey, b.publicKeyPem);
    const secretB = EncryptedChannel.deriveSharedSecret(b.privateKey, a.publicKeyPem);
    expect(secretA.equals(secretB)).toBe(true);
    const chA = new EncryptedChannel(secretA);
    const chB = new EncryptedChannel(secretB);
    expect(chB.decrypt(chA.encrypt('ping'))).toBe('ping');
  });
});

describe('PairingManager', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  });

  it('creates sessions and completes pairing with a phone key', () => {
    const pm = new PairingManager({ dataDir: dir });
    const payload = pm.createSession('192.168.1.5', 9444);
    expect(payload.sessionId).toBeTruthy();
    expect(payload.publicKeyPem).toContain('BEGIN PUBLIC KEY');

    const phone = EncryptedChannel.generateKeyPair();
    const { deviceId, channel } = pm.completePairing({
      sessionId: payload.sessionId,
      name: 'Pixel 9',
      devicePublicKeyPem: phone.publicKeyPem,
    });

    expect(pm.getDevice(deviceId)?.name).toBe('Pixel 9');
    expect(pm.openChannel(deviceId)).toBeTruthy();
    expect(channel.decrypt(channel.encrypt('hi'))).toBe('hi');
  });

  it('rejects reused or expired sessions', () => {
    const pm = new PairingManager({ dataDir: dir, sessionTtlMs: -1 });
    const payload = pm.createSession('localhost', 1);
    const phone = EncryptedChannel.generateKeyPair();

    expect(() => pm.completePairing({ sessionId: payload.sessionId, name: 'x', devicePublicKeyPem: phone.publicKeyPem }))
      .toThrow('expired');

    const pm2 = new PairingManager({ dataDir: dir });
    const p2 = pm2.createSession('localhost', 1);
    const phone2 = EncryptedChannel.generateKeyPair();
    pm2.completePairing({ sessionId: p2.sessionId, name: 'a', devicePublicKeyPem: phone2.publicKeyPem });
    expect(() => pm2.completePairing({ sessionId: p2.sessionId, name: 'b', devicePublicKeyPem: phone2.publicKeyPem }))
      .toThrow('already used');
  });

  it('persists paired devices across instances', () => {
    const pm = new PairingManager({ dataDir: dir });
    const payload = pm.createSession('localhost', 1);
    const phone = EncryptedChannel.generateKeyPair();
    const { deviceId } = pm.completePairing({ sessionId: payload.sessionId, name: 'iPhone', devicePublicKeyPem: phone.publicKeyPem });

    const pm2 = new PairingManager({ dataDir: dir });
    expect(pm2.getDevice(deviceId)?.name).toBe('iPhone');
    pm2.revokeDevice(deviceId);
    expect(pm2.getDevice(deviceId)).toBeUndefined();
  });
});

describe('P2PConnectionManager (end-to-end)', () => {
  let dir: string;
  let manager: P2PConnectionManager;
  let pairing: PairingManager;

  beforeEach(() => {
    dir = tmpDir();
    pairing = new PairingManager({ dataDir: dir });
    manager = new P2PConnectionManager({
      signalingPort: 0,
      stunServers: ['stun:stun.l.google.com:19302'],
      relayFps: 5,
      pairing,
      commandHandler: async (action, params) => `handled:${action}:${JSON.stringify(params)}`,
    });
    manager.start();
  });

  afterEach(() => {
    manager.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  });

  async function waitPort(timeout = 5000): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const addr = manager.getAddress();
      if (addr) return addr.port;
      await delay(25);
    }
    throw new Error('P2P server did not start');
  }

  it('pairs a phone, authenticates, and executes an encrypted command', async () => {
    const port = await waitPort();
    const payload = pairing.createSession('127.0.0.1', port);
    const phone = EncryptedChannel.generateKeyPair();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const phoneChannel = new EncryptedChannel(
      EncryptedChannel.deriveSharedSecret(phone.privateKey, payload.publicKeyPem),
    );
    const inbox: Record<string, unknown>[] = [];
    ws.on('message', raw => inbox.push(JSON.parse(raw.toString())));

    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });

    ws.send(JSON.stringify({ type: 'pair', sessionId: payload.sessionId, name: 'TestPhone', devicePublicKeyPem: phone.publicKeyPem }));

    await waitFor(() => inbox.some(m => m.type === 'paired'), 5000);
    const paired = inbox.find(m => m.type === 'paired') as any;
    expect(paired.deviceId).toBeTruthy();

    ws.send(JSON.stringify({ type: 'hello', deviceId: paired.deviceId }));
    await waitFor(() => inbox.some(m => m.type === 'welcome'), 5000);
    const welcome = inbox.find(m => m.type === 'welcome') as any;
    expect(welcome.webrtc).toBe(false);
    expect(welcome.relayFps).toBe(5);

    const enc = phoneChannel.encrypt({ t: 'cmd', action: 'test', params: { x: 1 }, reqId: 'r1' });
    ws.send(JSON.stringify({ type: 'enc', enc }));

    await waitFor(() => inbox.some(m => m.type === 'enc'), 5000);
    const resp = inbox.filter(m => m.type === 'enc')[0] as any;
    const inner = phoneChannel.decryptJson<any>(resp.enc);
    expect(inner.t).toBe('result');
    expect(inner.ok).toBe(true);
    expect(inner.result).toBe('handled:test:{"x":1}');

    ws.close();
  });

  it('rejects unauthenticated encrypted traffic', async () => {
    const port = await waitPort();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'enc', enc: { iv: 'a', tag: 'b', data: 'c', v: 1 } }));
    const inbox: Record<string, unknown>[] = [];
    ws.on('message', raw => inbox.push(JSON.parse(raw.toString())));
    await waitFor(() => inbox.some(m => m.type === 'error'), 3000);
    const err = inbox.find(m => m.type === 'error') as any;
    expect(err.error).toBe('Not paired');
    ws.close();
  });
});

async function waitFor(cond: () => boolean, timeout: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (cond()) return;
    await delay(25);
  }
  throw new Error('waitFor timed out');
}

