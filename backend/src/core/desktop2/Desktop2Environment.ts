import { VirtualDisplayManager } from '../workspace/VirtualDisplayManager';
import { VirtualDisplayRenderer, VirtualDisplayRendererState } from '../workspace/VirtualDisplayRenderer';
import { InputGuard } from '../workspace/InputGuard';
import { PrivacyGuard } from '../privacy/PrivacyGuard';
import { AuditVault } from '../vault/AuditVault';
import { BrowserManager, BrowserTab, PageInfo } from '../browser/BrowserManager';
import { ConsentGate } from '../agent/ConsentGate';
import { ApprovalGate } from '../agent/ApprovalGate';
import { getLogger } from '../Logger';

export interface Desktop2Config {
  width: number;
  height: number;
  fps: number;
  browserPath: string;
  dataDir: string;
  browserPort?: number;
  /**
   * CDP port of the headless Chromium the virtual displays render from.
   * Defaults to AgentDesktop's 9223.
   */
  renderCdpPort?: number;
  /** Set false to start Desktop 2 without a display renderer. */
  enableDisplayRenderer?: boolean;
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
  renderer: VirtualDisplayRendererState | null;
}

export class Desktop2Environment {
  private displayManager: VirtualDisplayManager;
  private renderer: VirtualDisplayRenderer | null;
  private inputGuard: InputGuard;
  private privacy: PrivacyGuard;
  private vault: AuditVault;
  private config: Desktop2Config;
  private browser: BrowserManager;
  private consent: ConsentGate | null;
  /** Optional hash+expiry+claim gate for sensitive actions (OpenMuse actions.ts port). */
  private approvalGate: ApprovalGate | null = null;
  private approvalOwner = 'desktop2';

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
    const renderer = config.enableDisplayRenderer === false
      ? null
      : new VirtualDisplayRenderer(displayManager, {
        cdpPort: config.renderCdpPort ?? 9223,
        // Every display page belongs to the renderer and starts blank; it
        // never inherits or captures a tab the user already had open.
        startUrl: '',
        idleFps: 2,
        canCapture: async () => {
          // Defence-in-depth: honour the emergency stop and the same capture
          // privacy check the explicit screenshot() path uses.
          if (this.consent && (await this.consent.checkEmergencyStop())) return false;
          return !this.privacy.inspectApp('desktop2_capture').blockCapture;
        },
      });
    this.renderer = renderer;
    renderer?.on('error', (displayId, err) => {
      getLogger().debug({ displayId, err: err.message }, 'Desktop 2: display render error');
    });
    // Defense-in-depth: gate even direct browser.evaluate() calls.
    this.browser.setEvaluateGuard(async (expression, currentUrl) => {
      if (this.consent && (await this.consent.checkEmergencyStop())) {
        throw new Error('Emergency stop armed — action blocked');
      }
      await this.requireConsent(`Run JavaScript in Desktop 2 browser (${expression.length} chars): ${expression.substring(0, 160)}`);
      const url = currentUrl || this.state.pageUrl || this.browser.getActiveTab()?.url || '';
      const check = this.privacy.inspectUrl(url);
      if (!check.allowed) throw new Error(`Privacy blocked: ${check.reason || 'sensitive URL'} — evaluate() refused`);
    });
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
      renderer: null,
    };
  }

  async start(): Promise<void> {
    if (this.state.isRunning) return;

    getLogger().info('Desktop 2 environment starting...');

    try {
      const display = await this.displayManager.create();
      this.state.displayId = display.id;
      // Use the real region computed by VirtualDisplayManager so InputGuard
      // can map synthetic coordinates to the correct virtual display.
      this.inputGuard.registerVirtualDisplay(display.id, display.region);
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'Desktop 2: virtual display unavailable, browser-only mode');
    }

    this.state.isRunning = true;
    this.state.startedAt = new Date();

    // The renderer follows display:created / display:destroyed, so it picks up
    // displays created by Desktop 2 and by the swarm alike.
    if (this.renderer) {
      try {
        await this.renderer.start();
        if (this.state.displayId !== null) {
          await this.renderer.setActiveDisplay(this.state.displayId);
        }
      } catch (e) {
        getLogger().warn({ err: (e as Error).message }, 'Desktop 2: display renderer failed to start');
      }
      this.state.renderer = this.renderer.getState();
    }

    getLogger().info(
      { displayId: this.state.displayId, renderer: this.state.renderer?.cdpConnected ?? false },
      'Desktop 2 environment ready',
    );
  }

  async stop(): Promise<void> {
    if (!this.state.isRunning) return;
    getLogger().info('Desktop 2 environment shutting down...');

    await this.closeBrowser();

    if (this.renderer) {
      await this.renderer.stop();
      this.state.renderer = null;
    }

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

  /**
   * A PNG frame for the preview stream / PWA.
   *
   * Prefers the live browser capture, but falls back to the active virtual
   * display's newest rendered frame — that is what makes Desktop 2's virtual
   * monitors show content on the phone preview (port 9090) even when no
   * interactive browser tab is open.
   */
  async screenshot(): Promise<Buffer | null> {
    const captureCheck = this.privacy.inspectApp('desktop2_capture');
    if (captureCheck.blockCapture) {
      getLogger().warn('Privacy: blocked Desktop 2 screenshot');
      return null;
    }

    if (this.browser.isRunning()) {
      const shot = await this.browser.screenshot();
      if (shot) return shot;
    }

    return this.getDisplayFramePng();
  }

  /**
   * Newest PNG rendered into a virtual display. Defaults to the focused
   * display. This is exactly the format PreviewStreamer expects.
   */
  getDisplayFramePng(displayId?: number): Buffer | null {
    if (!this.renderer) return null;
    const id = displayId ?? this.renderer.getActiveDisplayId() ?? this.state.displayId;
    if (id === null) return null;
    return this.renderer.getLatestPng(id);
  }

  /** Force a frame on one display (or all of them) right now. */
  async renderDisplay(displayId: number): Promise<boolean> {
    if (!this.renderer) return false;
    return (await this.renderer.renderDisplay(displayId)) !== null;
  }

  async renderAllDisplays(): Promise<number> {
    if (!this.renderer) return 0;
    const frames = await this.renderer.renderAll();
    this.state.renderer = this.renderer.getState();
    return frames.length;
  }

  /** Switch which virtual display is focused (full FPS + page focus). */
  async setActiveDisplay(displayId: number | null): Promise<void> {
    if (!this.renderer) return;
    await this.renderer.setActiveDisplay(displayId);
  }

  getRenderer(): VirtualDisplayRenderer | null {
    return this.renderer;
  }

  /**
   * Point a virtual display at a URL. The renderer only ever shows pages it
   * created, so this is the supported way to put real content on a display.
   * Consent- and privacy-gated like any other navigation.
   */
  async navigateDisplay(url: string, displayId?: number): Promise<string> {
    if (!this.renderer) throw new Error('Desktop 2 display renderer not running');
    const id = displayId ?? this.state.displayId;
    if (id === null) throw new Error('No virtual display available');

    const target = this.normalizeUrl(url);
    const urlCheck = this.privacy.inspectUrl(target);
    if (!urlCheck.allowed) {
      getLogger().warn({ url: target, reason: urlCheck.reason }, 'Privacy: blocked display navigation');
      throw new Error(`Privacy blocked: ${urlCheck.reason}`);
    }

    await this.requireConsent(`Show ${target} on virtual display ${id}`);

    const frame = await this.renderer.navigate(id, target);
    if (!frame) throw new Error('Display renderer could not navigate — is the browser running?');

    this.vault.log('desktop2_display_navigate', target, { displayId: id }, 'navigated');
    getLogger().info({ url: target, displayId: id }, 'Desktop 2: display navigated');
    return `Display ${id} → ${target}`;
  }

  async getAccessibilitySnapshot(): Promise<string | null> {
    if (!this.browser.isRunning()) return null;
    return this.browser.getAccessibilitySnapshot();
  }

  async evaluate(expression: string): Promise<unknown> {
    if (!this.browser.isRunning()) throw new Error('Desktop 2 browser not running');
    // Consent + URL guard: arbitrary JS can exfiltrate page content —
    // require an explicit grant and a privacy allow-check on the live URL.
    // The BrowserManager guard enforces the same checks for direct calls;
    // it is bypassed here after this explicit gate to avoid a double prompt.
    if (this.consent && (await this.consent.checkEmergencyStop())) {
      throw new Error('Emergency stop armed — action blocked');
    }
    await this.requireConsent(`Run JavaScript in Desktop 2 browser (${expression.length} chars): ${expression.substring(0, 160)}`);
    const liveUrl = this.state.pageUrl || this.browser.getActiveTab()?.url || '';
    const urlCheck = this.privacy.inspectUrl(liveUrl);
    if (!urlCheck.allowed) {
      throw new Error(`Privacy blocked: ${urlCheck.reason || 'sensitive URL'} — evaluate() refused`);
    }
    const guard = (this.browser as any).evaluateGuard;
    try {
      if (guard) this.browser.setEvaluateGuard(null);
      return await this.browser.evaluate(expression);
    } finally {
      if (guard) this.browser.setEvaluateGuard(guard);
    }
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
    // ApprovalGate consent check (hash+expiry verified when a proposal rides along).
    await this.checkApproval(params);

    const uiActions = ['click', 'clickSelector', 'type', 'typeInto', 'pressKey', 'hotkey', 'scroll', 'extract'];
    if (uiActions.includes(action) && !this.browser.isRunning()) {
      await this.browser.start(this.config.browserPath);
      await this.refreshState();
      getLogger().info('Desktop 2: browser auto-started for UI action');
    }

    getLogger().info({ action, params: this.redactParams(params) }, 'Desktop 2 executing action');

    this.vault.log('desktop2_action', action, this.redactParams(params), 'started');

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

      case 'renderDisplay':
        await this.requireConsent(`Render virtual display ${String(params.displayId ?? '')}`);
        const rendered = await this.renderDisplay(Number(params.displayId));
        return rendered ? 'Frame rendered to virtual display' : 'Display render failed';

      case 'renderAllDisplays':
        const count = await this.renderAllDisplays();
        return `Rendered ${count} virtual display(s)`;

      case 'navigateDisplay':
        return this.navigateDisplay(String(params.url || ''), params.displayId !== undefined ? Number(params.displayId) : undefined);

      case 'setActiveDisplay':
        await this.setActiveDisplay(params.displayId === undefined || params.displayId === null ? null : Number(params.displayId));
        return `Active display: ${this.renderer?.getActiveDisplayId() ?? 'none'}`;

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

    if (this.renderer) this.state.renderer = this.renderer.getState();

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

  /** Install the ApprovalGate (propose/decide hash+expiry+claim). */
  setApprovalGate(gate: ApprovalGate | null, owner = 'desktop2'): void {
    this.approvalGate = gate;
    this.approvalOwner = owner;
  }

  /** Propose a sensitive desktop action for explicit review (30m expiry). */
  async proposeAction(kind: string, data: Record<string, unknown>, taskId?: string): Promise<import('../agent/ApprovalGate').ActionProposal> {
    if (!this.approvalGate) throw new Error('ApprovalGate not configured');
    return this.approvalGate.propose(this.approvalOwner, kind, data, { taskId });
  }

  /** Read-only consent check: when approvalId/hash ride along, verify hash+expiry. */
  private async checkApproval(params: Record<string, unknown>): Promise<void> {
    if (!this.approvalGate) return;
    const id = params.approvalId;
    const hash = params.approvalHash;
    if (id === undefined && hash === undefined) return;
    if (typeof id !== 'string' || typeof hash !== 'string') throw new Error('Invalid approval reference');
    const proposal = this.approvalGate.get(this.approvalOwner, id);
    if (!proposal) throw new Error('Approval not found — propose the action first');
    if (proposal.hash !== hash) throw new Error('Approval hash mismatch — re-propose');
    if (proposal.status !== 'awaiting_review' && proposal.status !== 'executing') {
      throw new Error(`Approval is ${proposal.status} — create a fresh proposal`);
    }
    if (Date.parse(proposal.expiresAt) <= Date.now()) throw new Error('Approval expired — create a fresh proposal');
  }

  /**
   * Execute a sensitive action through the gate: decide() claims
   * awaiting_review -> executing exactly once, then runs executeAction.
   */
  async executeWithApproval(action: string, params: Record<string, unknown>, proposalId: string, hash: string): Promise<string> {
    if (!this.approvalGate) return this.executeAction(action, params);
    const gate = this.approvalGate;
    const owner = this.approvalOwner;
    const finished = await gate.decide(owner, proposalId, hash, 'approve', async () => {
      return this.executeAction(action, { ...params, approvalId: proposalId, approvalHash: hash });
    });
    if (finished.status !== 'succeeded') throw new Error(finished.error ?? `Approval ${finished.status}`);
    return finished.result ?? 'approved';
  }

  /** Truncate long values + mask secret-looking keys so logs never hold secrets. */
  private redactParams(params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (/secret|password|token|apikey|api_key|authorization|cookie/i.test(k)) {
        out[k] = '***';
      } else if (typeof v === 'string' && v.length > 300) {
        out[k] = `${v.substring(0, 300)}…(${v.length} chars)`;
      } else {
        out[k] = v;
      }
    }
    return out;
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
