import * as fs from 'fs';
import * as path from 'path';
import { ConsentGate } from '../agent/ConsentGate';
import { PrivacyGuard } from '../privacy/PrivacyGuard';
import { AuditVault } from '../vault/AuditVault';
import { ScreenReader } from '../vision/ScreenReader';
import { BrowserManager } from '../browser/BrowserManager';
import {
  createVirtualDesktop,
  switchVirtualDesktop,
  launchApp,
  focusWindow,
  moveWindow,
  getWindowRect,
  sendClick,
  sendScroll,
  typeText,
  sendKey,
  sendHotkey,
} from '../../native/win32/InputNative';
import { captureWindowPng } from '../../native/win32/ScreenCaptureNative';
import { getLogger } from '../Logger';

export interface RealDesktop2Config {
  chromePath: string;
  cdpPort: number;
  windowWidth: number;
  windowHeight: number;
  dataDir: string;
  chromeProfileDir?: string;
}

export interface RealDesktop2State {
  isOpen: boolean;
  app: string | null;
  chromeMode: boolean;
  chromeRealProfile: boolean;
  windowRect: { x: number; y: number; width: number; height: number } | null;
  taskCount: number;
  lastRead: string | null;
}

const DEFAULT_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/**
 * RealDesktop2 — "human mode". The agent works on a real second Windows
 * virtual desktop (Win+Ctrl+D): it can open any installed app and the user's
 * real Chrome (with logins) there, drive them with real mouse/keyboard input,
 * and read the screen back — while the user keeps using their own desktop.
 */
export class RealDesktop2 {
  private consent: ConsentGate | null;
  private privacy: PrivacyGuard;
  private vault: AuditVault;
  private screenReader: ScreenReader | null;
  private config: RealDesktop2Config;
  private chrome: BrowserManager | null = null;
  private chromeRealProfile: boolean = false;
  private opened: boolean = false;
  private onDesktop2: boolean = false;
  private currentApp: string | null = null;
  private taskCount: number = 0;
  private lastRead: string | null = null;
  private lastRect: { x: number; y: number; width: number; height: number } | null = null;

  constructor(
    consent: ConsentGate | null,
    privacy: PrivacyGuard,
    vault: AuditVault,
    screenReader: ScreenReader | null,
    config: RealDesktop2Config,
  ) {
    this.consent = consent;
    this.privacy = privacy;
    this.vault = vault;
    this.screenReader = screenReader;
    this.config = config;
  }

  // ─── Desktop management ────────────────────────────────────

  isOpen(): boolean {
    return this.opened;
  }

  private async goToDesktop2(): Promise<boolean> {
    if (!this.opened) {
      getLogger().info('RealDesktop2: creating Windows virtual desktop (Win+Ctrl+D)');
      if (!createVirtualDesktop()) {
        getLogger().warn('RealDesktop2: virtual desktop hotkey failed');
        return false;
      }
      this.opened = true;
      this.onDesktop2 = true;
      await this.sleep(800);
      return true;
    }
    if (!this.onDesktop2) {
      switchVirtualDesktop('right');
      this.onDesktop2 = true;
      await this.sleep(700);
    }
    return true;
  }

  private async backToUserDesktop(): Promise<void> {
    if (this.onDesktop2) {
      switchVirtualDesktop('left');
      this.onDesktop2 = false;
      await this.sleep(500);
    }
  }

  private async focusCurrentApp(): Promise<boolean> {
    if (!this.currentApp) return false;
    if (this.chrome && this.chrome.isRunning()) return true;
    if (focusWindow(this.currentApp)) return true;
    await this.backToUserDesktop();
    await this.goToDesktop2();
    return focusWindow(this.currentApp);
  }

  // ─── App launching ─────────────────────────────────────────

  private async waitForWindow(match: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getWindowRect(match)) return true;
      await this.sleep(500);
    }
    return false;
  }

  async openApp(app: string, args: string[] = []): Promise<string> {
    await this.requireConsent(`Open the application "${app}" on Desktop 2`);
    await this.goToDesktop2();
    if (!this.onDesktop2) throw new Error('Could not create/switch to Desktop 2 (virtual desktop hotkey unavailable)');

    const appCheck = this.privacy.inspectApp(app);
    if (!appCheck.allowed) {
      await this.backToUserDesktop();
      throw new Error(`Privacy blocked: ${appCheck.reason || 'sensitive application'}`);
    }

    if (!launchApp(app, args)) {
      await this.backToUserDesktop();
      throw new Error(`Could not launch "${app}"`);
    }

    const windowMatch = this.windowMatchFor(app);
    const found = await this.waitForWindow(windowMatch, 12000);
    if (!found) {
      getLogger().warn({ app, match: windowMatch }, 'RealDesktop2: app window not found, continuing anyway');
    } else {
      const rect = getWindowRect(windowMatch)!;
      moveWindow(windowMatch, 0, 0, this.config.windowWidth, this.config.windowHeight);
      focusWindow(windowMatch);
      await this.sleep(400);
      const moved = getWindowRect(windowMatch);
      this.lastRect = moved
        ? { x: moved.x, y: moved.y, width: moved.width, height: moved.height }
        : { x: 0, y: 0, width: this.config.windowWidth, height: this.config.windowHeight };
      void rect;
    }

    this.currentApp = windowMatch;
    this.chrome = null;
    this.taskCount++;
    this.vault.log('realdesktop_open_app', app, { args }, 'opened');
    getLogger().info({ app, windowMatch }, 'RealDesktop2: app opened on Desktop 2');
    await this.backToUserDesktop();
    return `Opened ${app} on Desktop 2`;
  }

  async openChrome(url?: string): Promise<string> {
    await this.requireConsent('Open your real Chrome (with your profile) on Desktop 2');
    await this.goToDesktop2();
    if (!this.onDesktop2) throw new Error('Could not create/switch to Desktop 2 (virtual desktop hotkey unavailable)');

    const exe = DEFAULT_CHROME_PATHS.find(p => fs.existsSync(p)) || this.config.chromePath;
    if (!fs.existsSync(exe)) {
      await this.backToUserDesktop();
      throw new Error('Chrome not found on this PC');
    }

    const profileDir = this.config.chromeProfileDir ||
      path.join(process.env['LOCALAPPDATA'] || path.join(process.env['USERPROFILE'] || '.', 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');

    const real = new BrowserManager(this.config.cdpPort, profileDir, {
      useDefaultProfile: false,
      killOnStop: false,
      extraArgs: ['--restore-last-session'],
    });

    if (!(await real.attach(this.config.cdpPort))) {
      const chromeRunning = await this.isProcessRunning('chrome');
      if (chromeRunning) {
        getLogger().warn('RealDesktop2: Chrome already running without a debug port — restarting it (session restore)');
        await this.requireConsent(
          'Your Chrome is already open without agent access. Umbra must close and restart Chrome ' +
          'with your profile so it can use your accounts. Your open tabs will be restored automatically.',
        );
        if (!this.killChrome()) {
          await this.backToUserDesktop();
          throw new Error('Could not close Chrome for restart — close it manually and try again');
        }
        await this.waitChromeExited(10000);
      } else {
        getLogger().info('RealDesktop2: Chrome not running — launching real profile with CDP');
      }

      const ok = await real.start(exe);
      if (!ok) {
        await this.backToUserDesktop();
        throw new Error('Real-profile Chrome failed to start with CDP');
      }
    } else {
      getLogger().info('RealDesktop2: attached to running real-profile Chrome via CDP');
    }

    this.chrome = real;
    this.chromeRealProfile = true;

    if (url) {
      const target = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`;
      const urlCheck = this.privacy.inspectUrl(target);
      if (!urlCheck.allowed) {
        await this.backToUserDesktop();
        throw new Error(`Privacy blocked: ${urlCheck.reason || 'sensitive URL'}`);
      }
      await this.chrome.navigate(target);
    }

    this.currentApp = 'chrome';
    this.taskCount++;
    this.vault.log('realdesktop_open_chrome', url || 'about:blank', { realProfile: true }, 'opened');
    getLogger().info({ url }, 'RealDesktop2: real-profile Chrome open on Desktop 2');
    await this.backToUserDesktop();
    return `Opened Chrome on Desktop 2 with your real profile (all your accounts available)`;
  }

  private windowMatchFor(app: string): string {
    const clean = app.trim();
    const base = clean.split(/[.\s\\/]/)[0];
    const lower = base.toLowerCase();
    const map: Record<string, string> = {
      notepad: 'notepad',
      calc: 'Calculator',
      calculator: 'Calculator',
      explorer: 'explorer',
      chrome: 'chrome',
      'google chrome': 'chrome',
      edge: 'msedge',
      'microsoft edge': 'msedge',
      firefox: 'firefox',
      word: 'WINWORD',
      excel: 'EXCEL',
      powerpoint: 'POWERPNT',
      settings: 'SystemSettings',
    };
    return map[lower] || lower;
  }

  // ─── Input (all consent-gated, performed on Desktop 2) ─────

  async click(x: number, y: number): Promise<string> {
    await this.requireConsent(`Click at (${x},${y}) on Desktop 2`);
    if (this.chrome && this.chrome.isRunning()) {
      await this.chrome.clickAt(x, y);
      return `Clicked at (${x},${y}) in Chrome`;
    }
    await this.goToDesktop2();
    if (!(await this.focusCurrentApp())) throw new Error('Desktop 2 app window not focusable');
    sendClick(Math.round(x), Math.round(y), 1);
    await this.backToUserDesktop();
    return `Clicked at (${x},${y}) on Desktop 2`;
  }

  async clickSelector(selector: string): Promise<string> {
    await this.requireConsent(`Click element ${selector} in Chrome`);
    if (!this.chrome || !this.chrome.isRunning()) throw new Error('Chrome not open on Desktop 2');
    const ok = await this.chrome.clickSelector(selector);
    return ok ? `Clicked ${selector} in Chrome` : `Selector not found: ${selector}`;
  }

  async type(text: string): Promise<string> {
    await this.requireConsent(`Type text (${text.length} chars) on Desktop 2`);
    if (this.chrome && this.chrome.isRunning()) {
      await this.chrome.typeText(text);
      return `Typed ${text.length} characters in Chrome`;
    }
    await this.goToDesktop2();
    if (!(await this.focusCurrentApp())) throw new Error('Desktop 2 app window not focusable');
    typeText(this.privacy.filterSensitiveData(text));
    await this.backToUserDesktop();
    return `Typed ${text.length} characters on Desktop 2`;
  }

  async pressKey(key: string): Promise<string> {
    await this.requireConsent(`Press ${key} on Desktop 2`);
    if (this.chrome && this.chrome.isRunning()) {
      await this.chrome.pressKey(key);
      return `Pressed ${key} in Chrome`;
    }
    await this.goToDesktop2();
    if (!(await this.focusCurrentApp())) throw new Error('Desktop 2 app window not focusable');
    sendKey(key);
    await this.backToUserDesktop();
    return `Pressed ${key} on Desktop 2`;
  }

  async pressHotkey(modifiers: string[], key: string): Promise<string> {
    await this.requireConsent(`Press hotkey ${modifiers}+${key} on Desktop 2`);
    if (this.chrome && this.chrome.isRunning()) {
      await this.chrome.pressHotkey(modifiers, key);
      return `Pressed ${modifiers}+${key} in Chrome`;
    }
    await this.goToDesktop2();
    if (!(await this.focusCurrentApp())) throw new Error('Desktop 2 app window not focusable');
    sendHotkey([...modifiers, key].join('+'));
    await this.backToUserDesktop();
    return `Pressed ${modifiers}+${key} on Desktop 2`;
  }

  async scroll(deltaX: number, deltaY: number): Promise<string> {
    await this.requireConsent(`Scroll (${deltaX},${deltaY}) on Desktop 2`);
    if (this.chrome && this.chrome.isRunning()) {
      await this.chrome.scroll(deltaX, deltaY);
      return `Scrolled (${deltaX},${deltaY}) in Chrome`;
    }
    await this.goToDesktop2();
    if (!(await this.focusCurrentApp())) throw new Error('Desktop 2 app window not focusable');
    sendScroll(640, 400, deltaY);
    await this.backToUserDesktop();
    return `Scrolled (${deltaX},${deltaY}) on Desktop 2`;
  }

  // ─── Screen reading ────────────────────────────────────────

  async captureWindow(): Promise<Buffer | null> {
    if (this.chrome && this.chrome.isRunning()) {
      return this.chrome.screenshot();
    }
    if (!this.currentApp) return null;
    return captureWindowPng(this.currentApp);
  }

  async readScreen(): Promise<string> {
    await this.requireConsent('Read the screen on Desktop 2');

    let text: string;

    if (this.chrome && this.chrome.isRunning()) {
      const snap = await this.chrome.getAccessibilitySnapshot();
      text = snap ? `[Chrome DOM snapshot]\n${snap}` : 'No DOM snapshot available';
    } else if (this.currentApp) {
      await this.goToDesktop2();
      await this.focusCurrentApp();
      const buf = await captureWindowPng(this.currentApp);
      await this.backToUserDesktop();
      if (!buf) throw new Error('Could not capture Desktop 2 app window');
      if (this.screenReader) {
        text = await this.screenReader.ocrImage(buf);
      } else {
        text = `[window captured, ${buf.length} bytes — no OCR available]`;
      }
      this.lastRead = text;
    } else {
      throw new Error('No app open on Desktop 2 — open one first (open_app / open_chrome)');
    }

    this.taskCount++;
    this.vault.log('realdesktop_read_screen', this.currentApp || 'desktop2', { chars: text.length }, 'read');
    return text.substring(0, 8000);
  }

  async getPageInfo(): Promise<string> {
    if (this.chrome && this.chrome.isRunning()) {
      const info = await this.chrome.getPageInfo();
      return JSON.stringify(info);
    }
    return JSON.stringify({ app: this.currentApp, rect: this.lastRect });
  }

  async evaluate(expression: string): Promise<string> {
    if (!this.chrome || !this.chrome.isRunning()) throw new Error('Chrome not open on Desktop 2');
    const val = await this.chrome.evaluate(expression);
    return typeof val === 'string' ? val : JSON.stringify(val);
  }

  // ─── Unified action entry (mirrors Desktop2Environment) ────

  async executeAction(action: string, params: Record<string, unknown>): Promise<string> {
    if (this.consent && (await this.consent.checkEmergencyStop())) {
      throw new Error('Emergency stop armed — action blocked');
    }

    getLogger().info({ action, params }, 'RealDesktop2 executing action');
    this.vault.log('realdesktop_action', action, params, 'started');

    switch (action) {
      case 'open_app':
        return this.openApp(
          String(params.app || ''),
          Array.isArray(params.args) ? params.args.map(String) : [],
        );

      case 'open_chrome':
        return this.openChrome(params.url ? String(params.url) : undefined);

      case 'app_click':
        return this.click(Number(params.x || 0), Number(params.y || 0));

      case 'app_click_selector':
        return this.clickSelector(String(params.selector || ''));

      case 'app_type':
        return this.type(String(params.text || ''));

      case 'app_key':
        return this.pressKey(String(params.key || 'Enter'));

      case 'app_hotkey':
        return this.pressHotkey(
          Array.isArray(params.modifiers) ? params.modifiers.map(String) : [],
          String(params.key || ''),
        );

      case 'app_scroll':
        return this.scroll(Number(params.deltaX || 0), Number(params.deltaY || 0));

      case 'read_screen':
        return this.readScreen();

      case 'get_info':
        return this.getPageInfo();

      case 'chrome_evaluate':
        return this.evaluate(String(params.expression || ''));

      case 'wait':
        const ms = Number(params.ms || 1000);
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (this.consent && (await this.consent.checkEmergencyStop())) {
            throw new Error('Emergency stop armed during wait');
          }
          await this.sleep(500);
        }
        return `Waited ${ms}ms`;

      default:
        throw new Error(`Unknown real-desktop action: ${action}`);
    }
  }

  getState(): RealDesktop2State {
    return {
      isOpen: this.opened,
      app: this.currentApp,
      chromeMode: !!(this.chrome && this.chrome.isRunning()),
      chromeRealProfile: this.chromeRealProfile,
      windowRect: this.lastRect,
      taskCount: this.taskCount,
      lastRead: this.lastRead ? this.lastRead.substring(0, 200) : null,
    };
  }

  async stop(): Promise<void> {
    if (this.chrome) {
      await this.chrome.stop();
      this.chrome = null;
    }
    getLogger().info('RealDesktop2 stopped');
  }

  // ─── Internals ─────────────────────────────────────────────

  private async requireConsent(reason: string): Promise<void> {
    if (!this.consent) return;
    if (await this.consent.checkEmergencyStop()) {
      throw new Error('Emergency stop armed — action blocked');
    }
    const result = await this.consent.request(reason);
    if (result !== 'granted') {
      throw new Error(`Consent denied: ${reason}`);
    }
  }

  private isProcessRunning(name: string): Promise<boolean> {
    return new Promise(resolve => {
      const { exec } = require('child_process') as typeof import('child_process');
      exec(`powershell -NoProfile -NonInteractive -Command "Get-Process -Name ${name} -ErrorAction SilentlyContinue | Select-Object -First 1"`, {
        timeout: 8000,
        windowsHide: true,
      }, (err: Error | null, stdout: string) => {
        if (err || !stdout || !stdout.trim()) return resolve(false);
        resolve(true);
      });
    });
  }

  private async killChrome(): Promise<boolean> {
    const { execSync } = require('child_process') as typeof import('child_process');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        execSync(
          'powershell -NoProfile -NonInteractive -Command "Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force"',
          { windowsHide: true, timeout: 15000, stdio: 'pipe' },
        );
      } catch { }
      if (!(await this.isProcessRunning('chrome'))) return true;
      await this.sleep(1200);
    }
    return !(await this.isProcessRunning('chrome'));
  }

  private async waitChromeExited(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isProcessRunning('chrome'))) return;
      await this.sleep(300);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
