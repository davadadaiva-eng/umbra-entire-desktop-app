import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RealDesktop2, RealDesktop2Config } from './RealDesktop2';
import { PrivacyGuard } from '../privacy/PrivacyGuard';
import { AuditVault } from '../vault/AuditVault';

function makeDesktop(config?: Partial<RealDesktop2Config>): RealDesktop2 {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-rd2-'));
  return new RealDesktop2(null, new PrivacyGuard(), new AuditVault(dir), null, {
    chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    cdpPort: 19224,
    windowWidth: 1280,
    windowHeight: 800,
    dataDir: dir,
    ...config,
  });
}

describe('RealDesktop2 chrome launch planner (no window multiplication)', () => {
  test('live CDP session is always reused', () => {
    expect(RealDesktop2.planChromeLaunch(true, true)).toEqual({ action: 'reuse', restoreSession: false });
    expect(RealDesktop2.planChromeLaunch(true, false)).toEqual({ action: 'reuse', restoreSession: false });
  });

  test('CDP down + Chrome down starts fresh (single window, no restore)', () => {
    expect(RealDesktop2.planChromeLaunch(false, false)).toEqual({ action: 'fresh-start', restoreSession: false });
  });

  test('CDP down + Chrome up relaunches with restore and no positional URL', () => {
    expect(RealDesktop2.planChromeLaunch(false, true)).toEqual({ action: 'relaunch-restore', restoreSession: true });
  });
});

describe('RealDesktop2 user-desktop mode', () => {
  const ENV_KEY = 'UMBRA_VIRTUAL_DESKTOP';
  const saved = process.env[ENV_KEY];

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  test('virtual desktop is OFF by default (agent works on the user desktop)', () => {
    delete process.env[ENV_KEY];
    expect(makeDesktop().usesVirtualDesktop()).toBe(false);
  });

  test('explicit config opt-in enables the legacy 2nd desktop', () => {
    delete process.env[ENV_KEY];
    expect(makeDesktop({ useVirtualDesktop: true }).usesVirtualDesktop()).toBe(true);
  });

  test('env UMBRA_VIRTUAL_DESKTOP=1 enables the legacy 2nd desktop', () => {
    process.env[ENV_KEY] = '1';
    expect(makeDesktop().usesVirtualDesktop()).toBe(true);
  });

  test('explicit config false wins over the env flag', () => {
    process.env[ENV_KEY] = '1';
    expect(makeDesktop({ useVirtualDesktop: false }).usesVirtualDesktop()).toBe(false);
  });
});
