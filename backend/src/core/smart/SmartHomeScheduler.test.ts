/**
 * SmartHomeScheduler — rule evaluation and command dispatch.
 *
 * The scheduler talks to whatever `SmartHomeCommandTarget` it is given, which is
 * the multi-platform hub in production and the legacy SmartThings service for
 * rules that predate it. These tests pin both of those paths.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SmartHomeScheduler, type SmartHomeCommandTarget } from './SmartHomeScheduler';
import type { SwitchCommand } from './SmartThingsService';

describe('SmartHomeScheduler', () => {
  let dir: string;
  let calls: Array<{ deviceId: string; command: SwitchCommand }>;
  let failNext: Error | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-smart-sched-'));
    calls = [];
    failNext = null;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function target(): SmartHomeCommandTarget {
    return {
      sendCommand: async (deviceId: string, command: SwitchCommand) => {
        if (failNext) {
          const e = failNext;
          failNext = null;
          throw e;
        }
        calls.push({ deviceId, command });
        return { ok: true };
      },
    };
  }

  test('dispatches a namespaced multi-platform id to the command target', async () => {
    const sched = new SmartHomeScheduler(target(), dir);
    sched.add({
      deviceId: 'homeassistant:light.kitchen',
      deviceName: 'Kitchen light',
      command: 'on',
      kind: 'everyMinutes',
      everyMinutes: 30,
    });

    const now = Date.now();
    const results = await sched.runDue(now);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, device: 'Kitchen light', command: 'on' });
    expect(calls).toEqual([{ deviceId: 'homeassistant:light.kitchen', command: 'on' }]);
  });

  test('keeps legacy bare SmartThings ids working', async () => {
    const sched = new SmartHomeScheduler(target(), dir);
    sched.add({ deviceId: 'lamp-1', deviceName: 'Lamp', command: 'off', kind: 'everyMinutes', everyMinutes: 5 });

    const results = await sched.runDue(Date.now());

    expect(results[0].ok).toBe(true);
    // The bare id is forwarded verbatim — routing is the caller's job.
    expect(calls).toEqual([{ deviceId: 'lamp-1', command: 'off' }]);
  });

  test('a failing rule is reported and is not retried until its next window', async () => {
    const sched = new SmartHomeScheduler(target(), dir);
    sched.add({ deviceId: 'tuya:bf7a1b', deviceName: 'Kettle', command: 'on', kind: 'everyMinutes', everyMinutes: 30 });
    failNext = new Error('Could not reach openapi.tuyaus.com — check the hub is online');

    const now = Date.now();
    const first = await sched.runDue(now);
    expect(first[0]).toMatchObject({ ok: false, device: 'Kettle' });
    expect(first[0].error).toContain('Could not reach');

    // lastRun is stamped even on failure, so the 30s tick doesn't hammer the API.
    const second = await sched.runDue(now + 1000);
    expect(second).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('does not fire a daily rule before its target time', async () => {
    const sched = new SmartHomeScheduler(target(), dir);
    sched.add({ deviceId: 'hubitat:31', deviceName: 'Porch', command: 'on', kind: 'at', at: '07:00' });

    const d = new Date();
    d.setHours(3, 0, 0, 0);
    expect(await sched.runDue(d.getTime())).toHaveLength(0);

    const after = new Date();
    after.setHours(7, 0, 30, 0);
    const fired = await sched.runDue(after.getTime());
    expect(fired).toHaveLength(1);
    expect(calls).toEqual([{ deviceId: 'hubitat:31', command: 'on' }]);
  });

  test('cancelled rules stop firing', async () => {
    const sched = new SmartHomeScheduler(target(), dir);
    const rule = sched.add({ deviceId: 'openhab:Item_1', deviceName: 'Hall', command: 'off', kind: 'everyMinutes', everyMinutes: 1 });

    expect(sched.cancel(rule.id)).toBe(true);
    expect(await sched.runDue(Date.now())).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('persists rules across instances', async () => {
    const first = new SmartHomeScheduler(target(), dir);
    first.add({ deviceId: 'hive:abc', deviceName: 'Bedroom', command: 'on', kind: 'everyMinutes', everyMinutes: 10 });

    const reloaded = new SmartHomeScheduler(target(), dir);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].deviceName).toBe('Bedroom');
  });
});
