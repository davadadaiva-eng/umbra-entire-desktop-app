import { MeshBridge, MeshDaemonLike } from './MeshBridge';

function fakeDaemon(overrides: Partial<MeshDaemonLike> = {}): MeshDaemonLike & { calls: string[] } {
  const calls: string[] = [];
  const state = { running: false };
  return {
    calls,
    get running() {
      return state.running;
    },
    start: async () => {
      calls.push('start');
      state.running = true;
    },
    stop: async () => {
      calls.push('stop');
      state.running = false;
    },
    status: async () => {
      calls.push('status');
      return { ok: true, paired_devices: 2 };
    },
    pairCreate: async () => {
      calls.push('pair');
      return { device_id: 'dev-1' };
    },
    pairDemo: async () => {
      calls.push('pairDemo');
      return { ok: true, match: true };
    },
    devicesList: async () => {
      calls.push('devices');
      return { devices: [{ device_id: 'dev-1' }] };
    },
    devicesRevoke: async id => {
      calls.push('revoke');
      return { ok: true, device_id: id };
    },
    ...overrides,
  } as MeshDaemonLike & { calls: string[] };
}

describe('MeshBridge', () => {
  it('does not start when disabled', async () => {
    const daemon = fakeDaemon();
    const bridge = new MeshBridge({ enabled: false, dataDir: '/tmp', client: daemon });
    const res = await bridge.start();
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('disabled');
    expect(daemon.calls).toEqual([]);
  });

  it('starts, reports status, and stops cleanly', async () => {
    const daemon = fakeDaemon();
    const bridge = new MeshBridge({ enabled: true, dataDir: '/tmp', name: 'pc', client: daemon });
    const start = await bridge.start();
    expect(start.ok).toBe(true);
    expect(bridge.running).toBe(true);

    const status = await bridge.status();
    expect(status.running).toBe(true);
    expect(status.paired_devices).toBe(2);

    const pair = await bridge.pair(60);
    expect(pair.device_id).toBe('dev-1');

    const devices = await bridge.devices();
    expect(devices.devices).toHaveLength(1);

    const revoked = await bridge.revoke('dev-1');
    expect(revoked.ok).toBe(true);

    await bridge.stop();
    expect(bridge.running).toBe(false);
    expect(daemon.calls).toEqual(['start', 'status', 'pair', 'devices', 'revoke', 'stop']);
  });

  it('gracefully reports not-running when the daemon never starts', async () => {
    const daemon = fakeDaemon({
      start: async () => {
        throw new Error('binary not found');
      },
    });
    const bridge = new MeshBridge({ enabled: true, dataDir: '/tmp', client: daemon });
    const start = await bridge.start();
    expect(start.ok).toBe(false);
    expect(start.reason).toContain('binary not found');
    expect(bridge.running).toBe(false);

    const status = await bridge.status();
    expect(status.running).toBe(false);

    // devices() is safe even when not running
    expect(await bridge.devices()).toEqual({ devices: [] });
  });

  it('throws from pair/revoke when not running', async () => {
    const daemon = fakeDaemon();
    const bridge = new MeshBridge({ enabled: true, dataDir: '/tmp', client: daemon });
    await expect(bridge.pair()).rejects.toThrow('not running');
    await expect(bridge.revoke('x')).rejects.toThrow('not running');
  });
});
