import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { exec, execSync } from 'child_process';
import { ConsentGate } from '../agent/ConsentGate';
import { launchApp } from '../../native/win32/InputNative';
import { getLogger } from '../Logger';

export interface AgentDesktopChromeConfig {
  path: string;
  cdpPort: number;
  profileDir: string;
}

/**
 * Agent Browser — one persistent Chrome instance the agent drives through
 * browser-use. It uses a dedicated agent profile (separate user-data-dir),
 * so the user's own Chrome is never touched: no kill, no restart, no extra
 * windows. Only when configured with the REAL profile dir does a running
 * Chrome block the debug port — then one consent-gated relaunch restores
 * exactly the tabs just closed (never restore + a positional URL together:
 * that combination opens an extra window on every relaunch).
 */
export class AgentDesktop {
  private consent: ConsentGate | null;
  private workspaceRoot: string;
  private chrome: AgentDesktopChromeConfig;
  private opened: boolean = false;
  private opening: Promise<boolean> | null = null;

  constructor(consent: ConsentGate | null, workspaceRoot: string, chrome: AgentDesktopChromeConfig) {
    this.consent = consent;
    this.workspaceRoot = workspaceRoot;
    this.chrome = chrome;
  }

  isOpen(): boolean {
    return this.opened;
  }

  async ensure(): Promise<boolean> {
    if (this.opened) return true;
    if (this.opening) return this.opening;

    if (await this.cdpUp()) {
      this.opened = true;
      getLogger().info('AgentDesktop: agent browser already running (CDP up)');
      return true;
    }

    if (this.consent && this.consent.isEmergencyStopArmed()) {
      getLogger().warn('AgentDesktop: emergency stop armed — agent browser not launched');
      return false;
    }

    this.opening = this.ensureRealChrome();
    const ok = await this.opening;
    this.opening = null;
    this.opened = ok;
    return ok;
  }

  private async ensureRealChrome(): Promise<boolean> {
    if (!fs.existsSync(this.chrome.path)) {
      getLogger().warn({ path: this.chrome.path }, 'AgentDesktop: Chrome not found — agent browser unavailable');
      return false;
    }

    // The agent profile lives in its own user-data-dir, so a running user
    // Chrome is NO reason to kill anything — two instances coexist. Only
    // when the agent profile IS the real profile (same directory) does a
    // running Chrome block the debug port and need a consent-gated relaunch.
    const realProfileDir = path.join(
      process.env['LOCALAPPDATA'] || path.join(process.env['USERPROFILE'] || '.', 'AppData', 'Local'),
      'Google', 'Chrome', 'User Data',
    );
    const usesRealProfile = this.sameDir(this.chrome.profileDir, realProfileDir);
    let restored = false;

    const chromeRunning = await this.isChromeRunning();
    if (chromeRunning && usesRealProfile) {
      getLogger().warn('AgentDesktop: Chrome running without agent access — restarting with debug port');
      if (this.consent) {
        const result = await this.consent.request(
          'Your Chrome is already open without agent access. Umbra must close and restart Chrome ' +
          'so the agent can use your profile and accounts. Your open tabs will be restored automatically.',
        );
        if (result !== 'granted') {
          getLogger().warn('AgentDesktop: restart consent denied — agent browser unavailable');
          return false;
        }
      }
      try {
        execSync('taskkill /F /IM chrome.exe', { windowsHide: true, timeout: 15000, stdio: 'pipe' });
      } catch {
        getLogger().warn('AgentDesktop: could not close Chrome — agent browser unavailable');
        return false;
      }
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await this.isChromeRunning())) {
        await new Promise(r => setTimeout(r, 300));
      }
      restored = true;
    }

    return this.launchAgentChrome(restored);
  }

  private sameDir(a: string, b: string): boolean {
    try {
      const norm = (p: string) => path.resolve(p).toLowerCase();
      return norm(a) === norm(b);
    } catch {
      return false;
    }
  }

  private async launchAgentChrome(restored: boolean): Promise<boolean> {
    const args = [
      `--remote-debugging-port=${this.chrome.cdpPort}`,
      `--user-data-dir=${this.chrome.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
    ];
    if (restored) {
      // We just closed the user's session: bring exactly those tabs back.
      // No positional URL — it would open one EXTRA window per relaunch
      // (the multi-window bug).
      args.push('--restore-last-session');
    } else {
      // Fresh start: exactly one window.
      args.push('about:blank');
    }
    if (!launchApp(this.chrome.path, args)) {
      getLogger().warn({ path: this.chrome.path }, 'AgentDesktop: Chrome launch command failed');
      return false;
    }
    for (let i = 0; i < 40; i++) {
      if (await this.cdpUp()) {
        getLogger().info({ port: this.chrome.cdpPort }, 'AgentDesktop: real-profile Chrome CDP ready');
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    getLogger().warn({ port: this.chrome.cdpPort }, 'AgentDesktop: Chrome CDP did not come up');
    return false;
  }

  private cdpUp(): Promise<boolean> {
    return new Promise(resolve => {
      const req = http.get(
        { host: '127.0.0.1', port: this.chrome.cdpPort, path: '/json/version', timeout: 1500 },
        res => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  private isChromeRunning(): Promise<boolean> {
    return new Promise(resolve => {
      exec(
        'powershell -NoProfile -NonInteractive -Command "Get-Process -Name chrome -ErrorAction SilentlyContinue | Select-Object -First 1"',
        { timeout: 8000, windowsHide: true },
        (err: Error | null, stdout: string) => {
          if (err || !stdout || !stdout.trim()) return resolve(false);
          resolve(true);
        },
      );
    });
  }
}
