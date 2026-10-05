import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserManager } from './BrowserManager';

function tmpProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-bm-'));
}

describe('BrowserManager launch args (window-count discipline)', () => {
  test('fresh start opens exactly one window (about:blank, no restore)', () => {
    const bm = new BrowserManager(19222, tmpProfile(), { killOnStop: false });
    const args = bm.buildLaunchArgs();
    expect(args).toContain('about:blank');
    expect(args).not.toContain('--restore-last-session');
    // Positional URL count: exactly one trailing target.
    expect(args.filter(a => !a.startsWith('--'))).toEqual(['about:blank']);
  });

  test('relaunch-restore restores the session with NO positional URL (no extra window)', () => {
    const bm = new BrowserManager(19223, tmpProfile(), { killOnStop: false, restoreSession: true });
    const args = bm.buildLaunchArgs();
    expect(args).toContain('--restore-last-session');
    expect(args.filter(a => !a.startsWith('--'))).toEqual([]);
  });

  test('restore + extraArgs never combine restore with a positional URL', () => {
    const bm = new BrowserManager(19224, tmpProfile(), {
      killOnStop: false,
      restoreSession: true,
      extraArgs: ['--disable-gpu'],
    });
    const args = bm.buildLaunchArgs();
    expect(args).toContain('--restore-last-session');
    expect(args).toContain('--disable-gpu');
    expect(args.filter(a => !a.startsWith('--'))).toEqual([]);
  });

  test('useDefaultProfile omits --user-data-dir', () => {
    const bm = new BrowserManager(19225, tmpProfile(), { useDefaultProfile: true });
    expect(bm.buildLaunchArgs().some(a => a.startsWith('--user-data-dir='))).toBe(false);
  });
});
