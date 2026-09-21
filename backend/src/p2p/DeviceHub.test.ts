import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceRegistry } from './DeviceRegistry';
import { DeviceHub } from './DeviceHub';
import { DeviceClient } from './DeviceClient';

const tmpDirs: string[] = [];

function makeDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

function makeRegistry(): DeviceRegistry {
  return new DeviceRegistry({ dataDir: makeDir('device-hub') });
}

describe('DeviceHub + DeviceClient', () => {
  let hub: DeviceHub;
  let registry: DeviceRegistry;
  let port: number;
  const clients: DeviceClient[] = [];

  beforeEach(() => {
    registry = makeRegistry();
    hub = new DeviceHub({ registry, port: 0, heartbeatTimeoutMs: 5000, sweepIntervalMs: 500 });
    hub.start();
    port = hub.getAddress()!.port;
  });

  afterEach(() => {
    for (const c of clients) c.stop();
    clients.length = 0;
    hub.stop();
  });

  it('authenticates devices, tracks presence, and relays device→device', async () => {
    const a = registry.redeemInvite(registry.createInvite().code, { name: 'Phone', role: 'phone' });
    const b = registry.redeemInvite(registry.createInvite().code, { name: 'Desktop', role: 'desktop' });

    const receivedA: any[] = [];
    const receivedB: any[] = [];
    const clientA = new DeviceClient({
      url: `ws://127.0.0.1:${port}/device-ws`, token: a.token, deviceId: a.deviceId,
      name: 'Phone', role: 'phone',
      onMessage: (from, msg) => receivedA.push({ from, msg }),
    });
    const clientB = new DeviceClient({
      url: `ws://127.0.0.1:${port}/device-ws`, token: b.token, deviceId: b.deviceId,
      name: 'Desktop', role: 'desktop',
      onMessage: (from, msg) => receivedB.push({ from, msg }),
    });
    clients.push(clientA, clientB);
    clientA.start();
    clientB.start();

    await waitFor(() => clientA.isConnected && clientB.isConnected);
    expect(hub.getStatus().connected).toBe(2);
    expect(hub.isOnline(a.deviceId)).toBe(true);
    expect(hub.isOnline(b.deviceId)).toBe(true);

    // Phone relays a command to the desktop through the hub.
    clientA.relay(b.deviceId, { t: 'cmd', action: 'open_chrome', params: {} });
    await waitFor(() => receivedB.length > 0);
    expect(receivedB[0].from).toBe(a.deviceId);
    expect(receivedB[0].msg.action).toBe('open_chrome');

    // Hub can push a message to a specific device.
    hub.send(a.deviceId, { t: 'push', note: 'hi' });
    await waitFor(() => receivedA.length > 0);
    expect(receivedA[0].msg.t).toBe('push');
  });

  it('rejects an invalid token', async () => {
    const client = new DeviceClient({
      url: `ws://127.0.0.1:${port}/device-ws`, token: 'not-a-real-token',
      name: 'Intruder', role: 'other',
    });
    clients.push(client);
    client.start();
    await waitFor(() => !client.isConnected, 3000);
    expect(client.isConnected).toBe(false);
  });

  it('supports hub→device request/response (task dispatch)', async () => {
    const joined = registry.redeemInvite(registry.createInvite().code, { name: 'Desktop', role: 'desktop' });
    const received: any[] = [];
    const client = new DeviceClient({
      url: `ws://127.0.0.1:${port}/device-ws`, token: joined.token, deviceId: joined.deviceId,
      name: 'Desktop', role: 'desktop',
      onMessage: (from, msg) => {
        received.push({ from, msg });
        if (msg.t === 'task' && msg.reqId) {
          client.reply(String(msg.reqId), { t: 'task-accepted', taskId: 'task-123' });
        }
      },
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.isConnected);

    const reply = await hub.request(joined.deviceId, { t: 'task', description: 'open chrome' });
    expect(reply.t).toBe('task-accepted');
    expect(reply.taskId).toBe('task-123');
    expect(received[0].from).toBe('hub');
    expect(received[0].msg.description).toBe('open chrome');
  });

  it('auto-reconnects after the hub restarts', async () => {
    const joined = registry.redeemInvite(registry.createInvite().code, { name: 'Desktop', role: 'desktop' });
    const statuses: boolean[] = [];
    const client = new DeviceClient({
      url: `ws://127.0.0.1:${port}/device-ws`, token: joined.token, deviceId: joined.deviceId,
      name: 'Desktop', role: 'desktop',
      reconnectBaseMs: 20, reconnectMaxMs: 100,
      onStatus: connected => statuses.push(connected),
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.isConnected);

    // Drop the hub; the client should notice and reconnect once it's back.
    hub.stop();
    await waitFor(() => !client.isConnected);

    hub = new DeviceHub({ registry, port, heartbeatTimeoutMs: 5000, sweepIntervalMs: 500 });
    hub.start();
    await waitFor(() => client.isConnected);

    expect(hub.getStatus().connected).toBe(1);
    expect(statuses[0]).toBe(true);
  });
});
