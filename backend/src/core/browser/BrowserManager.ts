import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import WebSocket from 'ws';
import { getLogger } from '../Logger';

export interface BrowserTab {
  id: string;
  type: string;
  title: string;
  url: string;
  wsUrl: string;
}

export interface PageInfo {
  title: string;
  url: string;
}

const DEFAULT_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const KEY_CODES: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Return: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Del: { key: 'Delete', code: 'Delete', vk: 46 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  Up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Space: { key: ' ', code: 'Space', vk: 32 },
  F1: { key: 'F1', code: 'F1', vk: 112 },
  F2: { key: 'F2', code: 'F2', vk: 113 },
  F3: { key: 'F3', code: 'F3', vk: 114 },
  F4: { key: 'F4', code: 'F4', vk: 115 },
  F5: { key: 'F5', code: 'F5', vk: 116 },
  F6: { key: 'F6', code: 'F6', vk: 117 },
  F7: { key: 'F7', code: 'F7', vk: 118 },
  F8: { key: 'F8', code: 'F8', vk: 119 },
  F9: { key: 'F9', code: 'F9', vk: 120 },
  F10: { key: 'F10', code: 'F10', vk: 121 },
  F11: { key: 'F11', code: 'F11', vk: 122 },
  F12: { key: 'F12', code: 'F12', vk: 123 },
};

export interface BrowserManagerOptions {
  useDefaultProfile?: boolean;
  killOnStop?: boolean;
  extraArgs?: string[];
}

export class BrowserManager {
  private process: ChildProcess | null = null;
  private attached: boolean = false;
  private port: number;
  private profileDir: string;
  private options: BrowserManagerOptions;
  private activeTab: BrowserTab | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private msgId = 0;

  constructor(port: number = 9222, profileDir?: string, options?: BrowserManagerOptions) {
    this.port = port;
    this.profileDir = profileDir || path.join(process.env['USERPROFILE'] || '.', '.umbra', 'edge-profile');
    this.options = { useDefaultProfile: false, killOnStop: true, ...options };
  }

  async start(browserPath?: string): Promise<boolean> {
    if (this.process) return true;
    const exe = browserPath || DEFAULT_PATHS.find(p => fs.existsSync(p));
    if (!exe) {
      getLogger().error('BrowserManager: no Edge/Chrome found');
      return false;
    }
    const args = [
      `--remote-debugging-port=${this.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--window-size=1280,800',
      'about:blank',
    ];
    if (!this.options.useDefaultProfile) {
      if (!fs.existsSync(this.profileDir)) fs.mkdirSync(this.profileDir, { recursive: true });
      args.splice(1, 0, `--user-data-dir=${this.profileDir}`);
    }
    if (this.options.extraArgs) args.push(...this.options.extraArgs);

    this.process = spawn(exe, args, { stdio: 'ignore' });

    const ready = await this.waitForEndpoint(15000);
    if (!ready) {
      getLogger().error('BrowserManager: CDP endpoint did not come up');
      this.stop();
      return false;
    }
    const tabs = await this.listTabs();
    const page = tabs.find(t => t.type === 'page') || tabs[0];
    if (page) await this.activateTab(page.id);
    getLogger().info({ port: this.port }, 'BrowserManager: CDP ready');
    return true;
  }

  async attach(port: number): Promise<boolean> {
    try {
      await this.httpGet(`http://127.0.0.1:${port}/json/version`);
    } catch {
      return false;
    }
    this.port = port;
    this.attached = true;
    try {
      const tabs = await this.listTabs();
      const page = tabs.find(t => t.type === 'page') || tabs[0];
      if (page) await this.activateTab(page.id);
      getLogger().info({ port }, 'BrowserManager: attached to running browser CDP');
      return true;
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'BrowserManager: attach failed');
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { }
      this.ws = null;
    }
    this.pending.clear();
    if (this.process && this.options.killOnStop) {
      try { this.process.kill(); } catch { }
    }
    this.process = null;
    this.attached = false;
    this.activeTab = null;
  }

  async listTabs(): Promise<BrowserTab[]> {
    const body = await this.httpGet(`http://127.0.0.1:${this.port}/json/list`);
    const targets = JSON.parse(body) as Array<Record<string, unknown>>;
    return targets.map(t => ({
      id: String(t.id || ''),
      type: String(t.type || ''),
      title: String(t.title || ''),
      url: String(t.url || ''),
      wsUrl: String(t.webSocketDebuggerUrl || ''),
    })).filter(t => t.wsUrl);
  }

  async newTab(url: string): Promise<BrowserTab | null> {
    const body = await this.httpPut(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`);
    const t = JSON.parse(body) as Record<string, unknown>;
    const tab: BrowserTab = {
      id: String(t.id || ''),
      type: String(t.type || 'page'),
      title: String(t.title || ''),
      url: String(t.url || ''),
      wsUrl: String(t.webSocketDebuggerUrl || ''),
    };
    await this.activateTab(tab.id);
    return tab;
  }

  async activateTab(id: string): Promise<void> {
    try { await this.httpGet(`http://127.0.0.1:${this.port}/json/activate/${encodeURIComponent(id)}`); } catch { }
    const tabs = await this.listTabs();
    const tab = tabs.find(t => t.id === id);
    if (!tab) throw new Error(`Tab not found: ${id}`);
    if (this.ws) {
      try { this.ws.close(); } catch { }
      this.ws = null;
    }
    await this.connect(tab);
    this.activeTab = tab;
  }

  async closeTab(id: string): Promise<void> {
    try { await this.httpGet(`http://127.0.0.1:${this.port}/json/close/${encodeURIComponent(id)}`); } catch { }
    if (this.activeTab && this.activeTab.id === id) {
      this.activeTab = null;
      if (this.ws) { try { this.ws.close(); } catch { } this.ws = null; }
    }
  }

  getActiveTab(): BrowserTab | null {
    return this.activeTab;
  }

  async navigate(url: string): Promise<void> {
    await this.ensureConnected();
    await this.call('Page.navigate', { url });
  }

  async getPageInfo(): Promise<PageInfo> {
    await this.ensureConnected();
    const res = await this.call('Runtime.evaluate', {
      expression: '({ title: document.title, url: location.href })',
      returnByValue: true,
    });
    return res?.result?.value as PageInfo || { title: '', url: '' };
  }

  async screenshot(): Promise<Buffer | null> {
    try {
      await this.ensureConnected();
      const res = await this.call('Page.captureScreenshot', { format: 'png' });
      if (res && res.data) return Buffer.from(res.data as string, 'base64');
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'BrowserManager: screenshot failed');
    }
    return null;
  }

  async getAccessibilitySnapshot(): Promise<string | null> {
    await this.ensureConnected();
    try {
      const res = await this.call('Runtime.evaluate', {
        expression: `(() => {
          const seen = new Set();
          const out = [];
          for (const el of document.querySelectorAll('a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],h1,h2,h3,h4,label,th')) {
            if (seen.has(el)) continue;
            seen.add(el);
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.top > innerHeight || r.bottom < 0) continue;
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 200);
            if (!text) continue;
            let desc = el.tagName.toLowerCase();
            if (el.tagName === 'INPUT' && el.type) desc += '[' + el.type + ']';
            if (el.id) desc += '#' + el.id;
            if (typeof el.className === 'string' && el.className.trim()) desc += '.' + el.className.trim().split(/\\s+/)[0];
            out.push(desc + ' "' + text + '" @' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height));
          }
          return out.join('\\n');
        })()`,
        returnByValue: true,
      });
      if (res?.result?.value) return String(res.result.value);
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'BrowserManager: snapshot failed');
    }
    return null;
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.ensureConnected();
    const base = { x, y, button: 'left' as const, clickCount: 1, pointerType: 'mouse' as const };
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async clickSelector(selector: string): Promise<boolean> {
    await this.ensureConnected();
    const res = await this.call('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 };
      })()`,
      returnByValue: true,
    });
    const pt = res?.result?.value as { x: number; y: number; visible: boolean } | null;
    if (!pt || !pt.visible) return false;
    await this.clickAt(Math.round(pt.x), Math.round(pt.y));
    return true;
  }

  async typeText(text: string): Promise<void> {
    await this.ensureConnected();
    await this.call('Input.insertText', { text });
  }

  async typeIntoSelector(selector: string, text: string): Promise<boolean> {
    const clicked = await this.clickSelector(selector);
    if (!clicked) return false;
    await new Promise(r => setTimeout(r, 150));
    await this.typeText(text);
    return true;
  }

  async pressKey(keyName: string): Promise<void> {
    await this.ensureConnected();
    const map = KEY_CODES[keyName];
    if (!map) throw new Error(`Unknown key: ${keyName}`);
    const keyDown = { type: 'keyDown', key: map.key, code: map.code, windowsVirtualKeyCode: map.vk, nativeVirtualKeyCode: map.vk, text: undefined };
    const keyUp = { type: 'keyUp', key: map.key, code: map.code, windowsVirtualKeyCode: map.vk, nativeVirtualKeyCode: map.vk };
    await this.call('Input.dispatchKeyEvent', keyDown);
    await this.call('Input.dispatchKeyEvent', keyUp);
  }

  async pressHotkey(modifiers: string[], keyName: string): Promise<void> {
    await this.ensureConnected();
    const map = KEY_CODES[keyName];
    if (!map) throw new Error(`Unknown key: ${keyName}`);
    const mods = {
      ctrl: modifiers.includes('ctrl') || modifiers.includes('control') || modifiers.includes('Ctrl'),
      alt: modifiers.includes('alt') || modifiers.includes('Alt'),
      shift: modifiers.includes('shift') || modifiers.includes('Shift'),
      meta: modifiers.includes('meta') || modifiers.includes('Win'),
    };
    const base = { key: map.key, code: map.code, windowsVirtualKeyCode: map.vk, nativeVirtualKeyCode: map.vk };
    const parts: Record<string, unknown>[] = [];
    if (mods.ctrl) parts.push({ type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
    if (mods.alt) parts.push({ type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 });
    if (mods.shift) parts.push({ type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
    if (mods.meta) parts.push({ type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91 });
    parts.push({ type: 'rawKeyDown', ...base });
    parts.push({ type: 'keyUp', ...base });
    if (mods.shift) parts.push({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
    if (mods.alt) parts.push({ type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 });
    if (mods.ctrl) parts.push({ type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
    if (mods.meta) parts.push({ type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91 });
    for (const p of parts) await this.call('Input.dispatchKeyEvent', p);
  }

  async scroll(deltaX: number, deltaY: number, x: number = 640, y: number = 400): Promise<void> {
    await this.ensureConnected();
    await this.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  }

  async evaluate(expression: string): Promise<unknown> {
    await this.ensureConnected();
    const res = await this.call('Runtime.evaluate', { expression, returnByValue: true });
    if (res?.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res?.result?.value;
  }

  isRunning(): boolean {
    return (!!this.process || this.attached) && !!this.activeTab;
  }

  private async connect(tab: BrowserTab): Promise<void> {
    this.ws = new WebSocket(tab.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try { this.ws!.close(); } catch { }
        reject(new Error('CDP ws connect timeout'));
      }, 10000);
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (e: Error) => { cleanup(); reject(e); };
      const cleanup = () => {
        clearTimeout(timer);
        this.ws!.off('open', onOpen);
        this.ws!.off('error', onError);
      };
      this.ws!.on('open', onOpen);
      this.ws!.on('error', onError);
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    this.ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
      this.ws = null;
    });
    this.ws.on('error', (e: Error) => {
      getLogger().warn({ err: e.message }, 'BrowserManager: ws error');
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.activeTab) {
      await this.connect(this.activeTab);
      return;
    }
    const tabs = await this.listTabs();
    const page = tabs.find(t => t.type === 'page') || tabs[0];
    if (!page) throw new Error('No browser tab available');
    await this.connect(page);
    this.activeTab = page;
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private waitForEndpoint(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      const probe = () => {
        this.httpGet(`http://127.0.0.1:${this.port}/json/version`)
          .then(() => resolve(true))
          .catch(() => {
            if (Date.now() > deadline) resolve(false);
            else setTimeout(probe, 250);
          });
      };
      probe();
    });
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('HTTP timeout')); });
    });
  }

  private httpPut(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'PUT' }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('HTTP timeout')); });
      req.end();
    });
  }
}
