import { VirtualDisplayManager } from '../workspace/VirtualDisplayManager';
import { InputGuard } from '../workspace/InputGuard';
import { PrivacyGuard } from '../privacy/PrivacyGuard';
import { AuditVault } from '../vault/AuditVault';
import { BrowserManager, BrowserTab, PageInfo } from '../browser/BrowserManager';
import { ConsentGate } from '../agent/ConsentGate';
import { getLogger } from '../Logger';

export interface Desktop2Config {
  width: number;
  height: number;
  fps: number;
  browserPath: string;
  dataDir: string;
  browserPort?: number;
}

export interface Desktop2State {
  isRunning: boolean;
  displayId: number | null;
  browserPid: number | null;
  startedAt: Date | null;
  taskCount: number;
  uptimeMs: number;
  tabs: number;
  activeTabId: string | null;
  pageTitle: string;
  pageUrl: string;
}

export class Desktop2Environment {
  private displayManager: VirtualDisplayManager;
  private inputGuard: InputGuard;
  private privacy: PrivacyGuard;
  private vault: AuditVault;
  private config: Desktop2Config;
  private browser: BrowserManager;
  private consent: ConsentGate | null;

  private state: Desktop2State;

  constructor(
    displayManager: VirtualDisplayManager,
    inputGuard: InputGuard,
    privacy: PrivacyGuard,
    vault: AuditVault,
    config: Desktop2Config,
    consent?: ConsentGate,
  ) {
    this.displayManager = displayManager;
    this.inputGuard = inputGuard;
    this.privacy = privacy;
    this.vault = vault;
    this.config = config;
    this.consent = consent || null;
    this.browser = new BrowserManager(config.browserPort || 9222, `${config.dataDir}${require('path').sep}edge-profile`);
    this.state = {
      isRunning: false,
      displayId: null,
      browserPid: null,
      startedAt: null,
      taskCount: 0,
      uptimeMs: 0,
      tabs: 0,
      activeTabId: null,
      pageTitle: '',
      pageUrl: '',
    };
  }

  async start(): Promise<void> {
    if (this.state.isRunning) return;

    getLogger().info('Desktop 2 environment starting...');

    try {
      const display = await this.displayManager.create();
      this.state.displayId = display.id;
      this.inputGuard.registerVirtualDisplay(display.id, {
        x: 0,
        y: 0,
        width: display.width,
        height: display.height,
      });
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'Desktop 2: virtual display unavailable, browser-only mode');
    }

    this.state.isRunning = true;
    this.state.startedAt = new Date();

    getLogger().info({ displayId: this.state.displayId }, 'Desktop 2 environment ready');
  }

  async stop(): Promise<void> {
    if (!this.state.isRunning) return;
    getLogger().info('Desktop 2 environment shutting down...');

    await this.closeBrowser();

    if (this.state.displayId) {
      this.inputGuard.unregisterVirtualDisplay(this.state.displayId);
      await this.displayManager.destroy(this.state.displayId);
      this.state.displayId = null;
    }

    this.state.isRunning = false;
    this.state.uptimeMs += this.state.startedAt ? Date.now() - this.state.startedAt.getTime() : 0;
    getLogger().info('Desktop 2 environment stopped');
  }

  async launchBrowser(url?: string): Promise<boolean> {
    if (!this.state.isRunning) throw new Error('Desktop 2 not running');

    const targetUrl = url || 'about:blank';
    const urlCheck = this.privacy.inspectUrl(targetUrl);
    if (!urlCheck.allowed) {
      getLogger().warn({ url: targetUrl, reason: urlCheck.reason }, 'Privacy: blocked browser launch');
      throw new Error(`Privacy blocked: ${urlCheck.reason}`);
    }

    const ok = await this.browser.start(this.config.browserPath);
    if (!ok) throw new Error('Could not start browser (Edge/Chrome not found)');

    if (targetUrl !== 'about:blank') {
      await this.browser.navigate(targetUrl);
    }
    await this.refreshState();

    this.vault.log('desktop2_browser', targetUrl, { displayId: this.state.displayId }, 'launched');
    return true;
  }

  async closeBrowser(): Promise<void> {
    await this.browser.stop();
    this.state.browserPid = null;
    this.state.tabs = 0;
    this.state.activeTabId = null;
    this.state.pageTitle = '';
    this.state.pageUrl = '';
    getLogger().info('Desktop 2 browser closed');
  }

  async navigate(url: string): Promise<void> {
    if (!this.state.isRunning) throw new Error('Desktop 2 not running');

    const targetUrl = this.normalizeUrl(url);
    const urlCheck = this.privacy.inspectUrl(targetUrl);
    if (!urlCheck.allowed) {
      getLogger().warn({ url: targetUrl, reason: urlCheck.reason }, 'Privacy: blocked navigation');
      throw new Error(`Privacy blocked: ${urlCheck.reason}`);
    }

    if (!this.browser.isRunning()) {
      await this.browser.start(this.config.browserPath);
    }

    await this.browser.navigate(targetUrl);
    await this.refreshState();
    this.vault.log('desktop2_navigate', targetUrl, { displayId: this.state.displayId }, 'navigated');
    getLogger().info({ url: targetUrl }, 'Desktop 2: navigated');
  }

  async newTab(url: string = 'about:blank'): Promise<BrowserTab | null> {
    if (!this.browser.isRunning()) {
      await this.browser.start(this.config.browserPath);
    }
    const tab = await this.browser.newTab(url);
    await this.refreshState();
    this.vault.log('desktop2_newtab', url, {}, 'opened');
    return tab;
  }

  async closeTab(id: string): Promise<void> {
    await this.browser.closeTab(id);
    await this.refreshState();
  }

  async activateTab(id: string): Promise<void> {
    await this.browser.activateTab(id);
    await this.refreshState();
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.browser.listTabs();
  }

  async getPageInfo(): Promise<PageInfo> {
    return this.browser.getPageInfo();
  }

  async click(x: number, y: number): Promise<void> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    await this.browser.clickAt(x, y);
    this.state.taskCount++;
    this.vault.log('desktop2_click', `(${x},${y})`, {}, 'clicked');
  }

  async clickSelector(selector: string): Promise<boolean> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    const ok = await this.browser.clickSelector(selector);
    if (ok) {
      this.state.taskCount++;
      this.vault.log('desktop2_click', selector, {}, 'clicked');
    }
    return ok;
  }

  async type(text: string): Promise<void> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    const filteredText = this.privacy.filterSensitiveData(text);
    await this.browser.typeText(text);
    this.state.taskCount++;
    this.vault.log('desktop2_type', 'typing', { length: text.length, filtered: filteredText !== text }, 'typed');
    getLogger().debug({ length: text.length }, 'Desktop 2: typed text');
  }

  async typeIntoSelector(selector: string, text: string): Promise<boolean> {
    if (!this.browser.isRunning()) return false;
    const ok = await this.browser.typeIntoSelector(selector, text);
    if (ok) {
      this.state.taskCount++;
      this.vault.log('desktop2_type', selector, { length: text.length }, 'typed');
    }
    return ok;
  }

  async pressKey(key: string): Promise<void> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    await this.browser.pressKey(key);
  }

  async pressHotkey(modifiers: string[], key: string): Promise<void> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    await this.browser.pressHotkey(modifiers, key);
  }

  async scroll(deltaX: number, deltaY: number, x?: number, y?: number): Promise<void> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    await this.browser.scroll(deltaX, deltaY, x, y);
  }

  async screenshot(): Promise<Buffer | null> {
    if (!this.browser.isRunning()) return null;

    const captureCheck = this.privacy.inspectApp('desktop2_capture');
    if (captureCheck.blockCapture) {
      getLogger().warn('Privacy: blocked Desktop 2 screenshot');
      return null;
    }

    return this.browser.screenshot();
  }

  async getAccessibilitySnapshot(): Promise<string | null> {
    if (!this.browser.isRunning()) return null;
    return this.browser.getAccessibilitySnapshot();
  }

  async evaluate(expression: string): Promise<unknown> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    return this.browser.evaluate(expression);
  }

  async extract(selector?: string): Promise<string> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    let extracted: unknown;
    if (selector) {
      extracted = await this.browser.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return (el.innerText || el.textContent || '').trim().substring(0, 5000);
      })()`);
    } else {
      extracted = await this.browser.evaluate(`(() => {
        return (document.body ? document.body.innerText || '' : '').trim().substring(0, 8000);
      })()`);
    }
    const text = extracted === null || extracted === undefined ? '' : String(extracted);
    if (!text) return 'No content extracted';
    return this.privacy.filterSensitiveData(text);
  }

  async recover(): Promise<boolean> {
    if (!this.browser.isRunning()) return false;
    getLogger().info('Desktop 2: attempting browser recovery (Escape, then reload)');

    const before = await this.browser.getAccessibilitySnapshot();
    try {
      await this.browser.pressKey('Escape');
      await this.sleep(600);
      await this.browser.pressKey('Escape');
      await this.sleep(1500);
    } catch {
      return false;
    }

    const after = await this.browser.getAccessibilitySnapshot();
    if (before !== after) {
      getLogger().info('Desktop 2: recovery succeeded via Escape');
      return true;
    }

    const info = await this.browser.getPageInfo();
    if (info && info.url && info.url !== 'about:blank') {
      try {
        await this.browser.navigate(info.url);
        await this.sleep(2500);
        getLogger().info('Desktop 2: recovery succeeded via page reload');
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private normalizeUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed || trimmed === 'about:blank') return trimmed;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  async executeAction(action: string, params: Record<string, unknown>): Promise<string> {
    if (this.consent && (await this.consent.checkEmergencyStop())) {
      throw new Error('Emergency stop armed — action blocked');
    }

    const uiActions = ['click', 'clickSelector', 'type', 'typeInto', 'pressKey', 'hotkey', 'scroll', 'extract'];
    if (uiActions.includes(action) && !this.browser.isRunning()) {
      await this.browser.start(this.config.browserPath);
      await this.refreshState();
      getLogger().info('Desktop 2: browser auto-started for UI action');
    }

    getLogger().info({ action, params }, 'Desktop 2 executing action');

    this.vault.log('desktop2_action', action, params, 'started');

    switch (action) {
      case 'launchBrowser':
        await this.launchBrowser(String(params.url || 'about:blank'));
        return 'Browser launched';

      case 'navigate':
        await this.navigate(String(params.url || ''));
        return `Navigated to ${params.url}`;

      case 'newTab':
        const tab = await this.newTab(String(params.url || 'about:blank'));
        return tab ? `Opened tab ${tab.id}` : 'Tab open failed';

      case 'closeTab':
        await this.closeTab(String(params.id || ''));
        return 'Tab closed';

      case 'listTabs':
        const tabs = await this.listTabs();
        return JSON.stringify(tabs.map(t => ({ id: t.id, title: t.title, url: t.url })));

      case 'activateTab':
        await this.activateTab(String(params.id || ''));
        return 'Tab activated';

      case 'getInfo':
        const info = await this.getPageInfo();
        return JSON.stringify(info);

      case 'click':
        await this.requireConsent(`Click at (${params.x},${params.y}) on Desktop 2`);
        await this.click(Number(params.x || 0), Number(params.y || 0));
        return `Clicked at (${params.x},${params.y})`;

      case 'clickSelector':
        await this.requireConsent(`Click element ${params.selector} on Desktop 2`);
        const found = await this.clickSelector(String(params.selector || ''));
        return found ? `Clicked ${params.selector}` : `Selector not found: ${params.selector}`;

      case 'type':
        await this.requireConsent(`Type text (${String(params.text || '').length} chars) on Desktop 2`);
        await this.type(String(params.text || ''));
        return `Typed ${String(params.text || '').length} characters`;

      case 'typeInto':
        await this.requireConsent(`Type into ${params.selector} on Desktop 2`);
        const typed = await this.typeIntoSelector(String(params.selector || ''), String(params.text || ''));
        return typed ? `Typed into ${params.selector}` : `Selector not found: ${params.selector}`;

      case 'pressKey':
        await this.requireConsent(`Press ${params.key} on Desktop 2`);
        await this.pressKey(String(params.key || 'Enter'));
        return `Pressed ${params.key}`;

      case 'hotkey':
        await this.requireConsent(`Press hotkey ${params.modifiers}+${params.key} on Desktop 2`);
        await this.pressHotkey(
          Array.isArray(params.modifiers) ? params.modifiers as string[] : [],
          String(params.key || ''),
        );
        return `Pressed ${params.modifiers}+${params.key}`;

      case 'scroll':
        await this.requireConsent(`Scroll (${params.deltaX},${params.deltaY}) on Desktop 2`);
        await this.scroll(
          Number(params.deltaX || 0),
          Number(params.deltaY || 0),
          params.x ? Number(params.x) : undefined,
          params.y ? Number(params.y) : undefined,
        );
        return `Scrolled (${params.deltaX},${params.deltaY})`;

      case 'screenshot':
        const buf = await this.screenshot();
        return buf ? `Screenshot taken (${buf.length} bytes)` : 'Screenshot failed';

      case 'snapshot':
        const snap = await this.getAccessibilitySnapshot();
        return snap ? snap : 'Snapshot failed';

      case 'evaluate':
        const val = await this.evaluate(String(params.expression || ''));
        return typeof val === 'string' ? val : JSON.stringify(val);

      case 'extract':
        const extracted = await this.extract(params.selector ? String(params.selector) : undefined);
        return extracted;

      case 'wait':
        const ms = Number(params.ms || 1000);
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (this.consent && (await this.consent.checkEmergencyStop())) {
            throw new Error('Emergency stop armed during wait');
          }
          await new Promise(r => setTimeout(r, 500));
        }
        return `Waited ${ms}ms`;

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  getState(): Desktop2State {
    const currentUptime = this.state.startedAt
      ? this.state.uptimeMs + (Date.now() - this.state.startedAt.getTime())
      : this.state.uptimeMs;

    return { ...this.state, uptimeMs: currentUptime };
  }

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

  private async refreshState(): Promise<void> {
    try {
      const tabs = await this.browser.listTabs();
      this.state.tabs = tabs.length;
      const active = this.browser.getActiveTab();
      this.state.activeTabId = active ? active.id : null;
      const info = await this.browser.getPageInfo();
      this.state.pageTitle = info.title;
      this.state.pageUrl = info.url;
    } catch { }
  }
}
