import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceRegistry } from './DeviceRegistry';

const tmpDirs: string[] = [];

function makeDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DeviceRegistry', () => {
  it('invite → redeem → authenticate round-trips a device token', () => {
    const registry = new DeviceRegistry({ dataDir: makeDir('device-reg') });
    const invite = registry.createInvite('My Phone');

    const joined = registry.redeemInvite(invite.code, { name: 'Pixel 9', role: 'phone', capabilities: ['control'] });
    expect(joined.deviceId).toMatch(/^device-/);
    expect(joined.token).toHaveLength(64);

    const authed = registry.authenticate(joined.token);
    expect(authed).toBeTruthy();
    expect(authed!.deviceId).toBe(joined.deviceId);
    expect(authed!.role).toBe('phone');

    expect(registry.authenticate('bad-token')).toBeNull();
  });

  it('rejects a used or unknown invite code', () => {
    const registry = new DeviceRegistry({ dataDir: makeDir('device-reg-2') });
    const invite = registry.createInvite();
    registry.redeemInvite(invite.code, { name: 'A' });
    expect(() => registry.redeemInvite(invite.code, { name: 'B' })).toThrow('Unknown invite code');
    expect(() => registry.redeemInvite('nope', { name: 'C' })).toThrow('Unknown invite code');
  });

  it('persists devices across registry restarts', () => {
    const dir = makeDir('device-reg-3');
    const r1 = new DeviceRegistry({ dataDir: dir });
    const joined = r1.redeemInvite(r1.createInvite().code, { name: 'Desktop', role: 'desktop' });

    const r2 = new DeviceRegistry({ dataDir: dir });
    const authed = r2.authenticate(joined.token);
    expect(authed).toBeTruthy();
    expect(authed!.name).toBe('Desktop');
  });

  it('revokes a device', () => {
    const registry = new DeviceRegistry({ dataDir: makeDir('device-reg-4') });
    const joined = registry.redeemInvite(registry.createInvite().code, { name: 'x' });
    registry.revokeDevice(joined.deviceId);
    expect(registry.authenticate(joined.token)).toBeNull();
    expect(registry.listDevices()).toHaveLength(0);
  });
});
