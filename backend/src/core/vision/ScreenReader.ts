import Tesseract from 'tesseract.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { LLMConnector, LLMMessage } from '../agent/LLMConnector';
import { PrivacyGuard } from '../privacy/PrivacyGuard';
import { getLogger } from '../Logger';
import { extractJson } from '../utils/extractJson';

export interface ScreenContent {
  rawText: string;
  filteredText: string;
  appName: string;
  windowTitle: string;
  url?: string;
  visibleElements: VisibleElement[];
  privacyBlocks: PrivacyBlock[];
  timestamp: Date;
}

export interface VisibleElement {
  type: 'text' | 'button' | 'input' | 'link' | 'image' | 'heading' | 'list';
  content: string;
  position?: { x: number; y: number; width: number; height: number };
}

export interface PrivacyBlock {
  category: string;
  originalSnippet: string;
  maskedSnippet: string;
  reason: string;
}

class OcrSemaphore {
  private available: number;
  private slots: number[];
  private waiters: ((slot: number) => void)[] = [];

  constructor(slots: number) {
    this.available = slots;
    this.slots = Array.from({ length: slots }, (_, i) => i);
  }

  acquire(): Promise<{ slot: number; release: () => void }> {
    if (this.slots.length > 0) {
      const slot = this.slots.shift()!;
      return Promise.resolve({ slot, release: () => this.release(slot) });
    }
    return new Promise((resolve) => {
      this.waiters.push((slot: number) => resolve({ slot, release: () => this.release(slot) }));
    });
  }

  private release(slot: number): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(slot);
    } else {
      this.slots.push(slot);
    }
  }
}

export class ScreenReader {
  private llm?: LLMConnector;
  private privacy: PrivacyGuard;
  private lastContent: ScreenContent | null = null;
  private ocrWorkers: (Tesseract.Worker | null)[] = [];
  private semaphore: OcrSemaphore;
  private lastOcrText: string = '';
  private poolSize: number;

  constructor(privacy: PrivacyGuard, options?: { ocrPoolSize?: number }) {
    this.privacy = privacy;
    this.poolSize = options?.ocrPoolSize ?? 2;
    this.semaphore = new OcrSemaphore(this.poolSize);
  }

  setLLM(llm: LLMConnector): void {
    this.llm = llm;
  }

  async warmup(): Promise<void> {
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) =>
      this.getOcrWorker(i).catch(() => null),
    ));
  }

  private async getOcrWorker(index: number): Promise<Tesseract.Worker | null> {
    if (!this.ocrWorkers[index]) {
      try {
        getLogger().info({ index }, 'Initializing Tesseract OCR worker');
        const langPath = await this.resolveLangPath();
        if (langPath) {
          getLogger().info({ langPath }, 'Using local Tesseract traineddata');
        } else {
          getLogger().warn('No local traineddata found — falling back to Tesseract CDN');
        }
        this.ocrWorkers[index] = await Tesseract.createWorker('eng', 1, {
          ...(langPath ? { langPath } : {}),
          logger: (m: Tesseract.LoggerMessage) => {
            if (m.status === 'recognizing') getLogger().debug({ progress: m.progress }, 'Tesseract');
          },
        });
        getLogger().info({ index }, 'Tesseract OCR worker ready');
      } catch (e) {
        getLogger().warn({ err: e, index }, 'Failed to initialize Tesseract OCR worker');
        return null;
      }
    }
    return this.ocrWorkers[index] ?? null;
  }

  private async resolveLangPath(): Promise<string | undefined> {
    const langDir = path.join(os.homedir(), '.umbra', 'lang');
    const candidates = [langDir, process.cwd()];

    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'eng.traineddata.gz'))) return dir;
    }

    const raw = path.join(process.cwd(), 'eng.traineddata');
    if (fs.existsSync(raw)) {
      try {
        fs.mkdirSync(langDir, { recursive: true });
        const dest = path.join(langDir, 'eng.traineddata.gz');
        if (!fs.existsSync(dest)) {
          fs.writeFileSync(dest, zlib.gzipSync(fs.readFileSync(raw)));
          getLogger().info('Prepared eng.traineddata.gz from local source');
        }
        return langDir;
      } catch (err: any) {
        getLogger().debug({ err: err.message }, 'Failed to prepare local traineddata');
      }
    }

    return undefined;
  }

  async ocrImage(screenshotBuffer: Buffer): Promise<string> {
    const { slot, release } = await this.semaphore.acquire();
    try {
      const worker = await this.getOcrWorker(slot);
      if (!worker) return '';
      const { data } = await worker.recognize(screenshotBuffer);
      this.lastOcrText = data.text || '';
      return this.lastOcrText;
    } catch (e) {
      getLogger().warn({ err: e }, 'OCR recognition failed');
      return '';
    } finally {
      release();
    }
  }

  buildBasicContent(rawText: string, timestamp?: Date): ScreenContent {
    const content: Omit<ScreenContent, 'filteredText' | 'privacyBlocks'> = {
      rawText,
      appName: 'screen',
      windowTitle: '',
      visibleElements: [{ type: 'text', content: rawText.substring(0, 500) }],
      timestamp: timestamp || new Date(),
    };
    return this.applyPrivacyFilter(content);
  }

  async readScreen(screenshotBuffer: Buffer): Promise<ScreenContent> {
    const timestamp = new Date();

    const rawText = await this.ocrImage(screenshotBuffer);
    if (!rawText) {
      getLogger().warn('Tesseract OCR returned empty text');
      return this.fallbackRead();
    }

    let appName = 'screen';
    let windowTitle = '';
    let url: string | undefined;
    let elements: VisibleElement[] = [];

    if (this.llm) {
      try {
        const base64Image = screenshotBuffer.toString('base64');
        const context = await this.analyzeContextWithVlm(base64Image, rawText);
        appName = context.appName || appName;
        windowTitle = context.windowTitle || '';
        url = context.url || undefined;
        elements = (context.elements || []).map((e: any) => ({
          type: e.type || 'text',
          content: e.content || '',
          position: e.position,
        }));
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'VLM context analysis failed');
        elements = [{ type: 'text', content: rawText.substring(0, 500) }];
      }
    } else {
      elements = [{ type: 'text', content: rawText.substring(0, 500) }];
    }

    const content: Omit<ScreenContent, 'filteredText' | 'privacyBlocks'> = {
      rawText,
      appName,
      windowTitle,
      url,
      visibleElements: elements,
      timestamp,
    };

    const filtered = this.applyPrivacyFilter(content);
    this.lastContent = filtered;
    return filtered;
  }

  async enrichContext(screenshotBuffer: Buffer, ocrText: string): Promise<Pick<ScreenContent, 'appName' | 'windowTitle' | 'url' | 'visibleElements'>> {
    const heuristic = this.inferAppFromText(ocrText);

    if (this.llm) {
      try {
        const base64Image = screenshotBuffer.toString('base64');
        const context = await this.analyzeContextWithVlm(base64Image, ocrText);
        if (context.appName && context.appName !== 'screen') {
          return {
            appName: context.appName,
            windowTitle: context.windowTitle || heuristic.windowTitle,
            url: context.url || heuristic.url,
            visibleElements: (context.elements || []).map((e: any) => ({
              type: e.type || 'text',
              content: e.content || '',
              position: e.position,
            })),
          };
        }
      } catch {
        getLogger().debug('VLM enrichment failed, using heuristic');
      }
    }

    return heuristic;
  }

  private inferAppFromText(ocrText: string): Pick<ScreenContent, 'appName' | 'windowTitle' | 'url' | 'visibleElements'> {
    const lower = ocrText.toLowerCase();
    let appName = 'screen';
    let windowTitle = '';
    let url: string | undefined;

    const urlMatch = ocrText.match(/https?:\/\/[^\s)]+/);
    if (urlMatch) url = urlMatch[0];

    if (/google chrome|chrome[\s_-]|chrom(e|ium)/i.test(lower)) appName = 'chrome';
    else if (/firefox|mozilla/i.test(lower)) appName = 'firefox';
    else if (/microsoft edge|edge\b/i.test(lower)) appName = 'edge';
    else if (/visual studio code|vscode/i.test(lower)) appName = 'vscode';
    else if (/cursor\b/i.test(lower) && !/cursor.*pointer|mouse/i.test(lower)) appName = 'cursor';
    else if (/windows ?terminal|powershell|cmd\.exe|command prompt/i.test(lower)) appName = 'terminal';
    else if (/outlook|mail\b/i.test(lower)) appName = 'outlook';
    else if (/slack\b/i.test(lower)) appName = 'slack';
    else if (/discord\b/i.test(lower)) appName = 'discord';
    else if (/spotify\b/i.test(lower)) appName = 'spotify';
    else if (/notion\b/i.test(lower)) appName = 'notion';
    else if (/word|excel|powerpoint|office/i.test(lower)) appName = 'office';
    else if (/github\.com|gitlab\.com/i.test(lower)) appName = 'browser';
    else if (url && /https?:\/\//.test(url)) appName = 'browser';

    if (url) {
      const titleMatch = url.match(/https?:\/\/([^/]+)/);
      if (titleMatch) windowTitle = titleMatch[1];
    }

    return { appName, windowTitle, url, visibleElements: [{ type: 'text', content: ocrText.substring(0, 500) }] };
  }

  private async analyzeContextWithVlm(
    base64Image: string,
    _ocrText: string,
  ): Promise<{ appName?: string; windowTitle?: string; url?: string; elements?: any[] }> {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Look at this screenshot. Identify: the foreground application, the window title, any visible browser URL in the address bar, and up to 5 main UI sections.

Reply with exactly one JSON object and nothing else. No explanations, no markdown, no text before or after the JSON.
{"appName": "...", "windowTitle": "...", "url": "...", "elements": [{"type": "heading|text|button|link|input|list", "content": "short label, max 40 chars"}]}

Example output (do NOT copy this example — describe what you actually see in the screenshot):
{"appName": "spotify", "windowTitle": "Now Playing", "url": null, "elements": [{"type": "text", "content": "Track title"}]}`,
          },
          { type: 'image', image: base64Image, detail: 'low' },
        ],
      },
    ];

    const result = await this.llm!.complete(messages, 'vision', {
      temperature: 0.1,
      maxTokens: 512,
    });

    const parsed = extractJson(result.content);
    if (parsed) return parsed;

    const fields = this.extractFieldsFromRaw(result.content);
    if (fields.appName || fields.url) {
      getLogger().debug('VLM JSON malformed — salvaged core fields');
      return fields;
    }

    getLogger().warn({ snippet: result.content.substring(0, 300) }, 'VLM returned unparsable JSON');
    return {};
  }

  private extractFieldsFromRaw(raw: string): { appName?: string; windowTitle?: string; url?: string } {
    const result: { appName?: string; windowTitle?: string; url?: string } = {};
    const appMatch = raw.match(/"appName"\s*:\s*"([^"\\]{1,50})"/);
    if (appMatch) result.appName = appMatch[1];
    const titleMatch = raw.match(/"windowTitle"\s*:\s*"([^"\\]{1,150})"/);
    if (titleMatch) result.windowTitle = titleMatch[1];
    const urlMatch = raw.match(/"url"\s*:\s*(null|"([^"]{1,200})")/);
    if (urlMatch && urlMatch[2]) result.url = urlMatch[2];
    return result;
  }

  private applyPrivacyFilter(content: Omit<ScreenContent, 'filteredText' | 'privacyBlocks'>): ScreenContent {
    const blocks: PrivacyBlock[] = [];
    let filteredText = content.rawText;

    const patterns = [
      { category: 'credit_card', regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, mask: '****-****-****-****' },
      { category: 'ssn', regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, mask: '***-**-****' },
      { category: 'api_key', regex: /\b(sk-[A-Za-z0-9]{20,}|pk-[A-Za-z0-9]{20,})\b/g, mask: 'sk-***' },
      { category: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, mask: '***.***.***' },
      { category: 'private_key', regex: /-----BEGIN\s*(?:RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----[\s\S]*?-----END\s*(?:RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/g, mask: '[PRIVATE KEY REMOVED]' },
      { category: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask: (m: string) => {
        const [name, domain] = m.split('@');
        return `${name[0]}***@${domain}`;
      }},
      { category: 'password_field', regex: /(password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi, mask: (m: string) => {
        const label = m.split(/[:=]/)[0];
        return `${label}=***`;
      }},
    ];

    for (const pattern of patterns) {
      filteredText = filteredText.replace(pattern.regex, (match: string) => {
        const masked = typeof pattern.mask === 'function' ? pattern.mask(match) : pattern.mask;
        blocks.push({
          category: pattern.category,
          originalSnippet: match.substring(0, 20) + (match.length > 20 ? '...' : ''),
          maskedSnippet: masked,
          reason: `Auto-masked ${pattern.category}`,
        });
        return masked;
      });
    }

    const urlCheck = content.url ? this.privacy.inspectUrl(content.url) : { allowed: true };
    if (!urlCheck.allowed) {
      filteredText = filteredText.replace(
        new RegExp(content.url!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        '[PRIVATE URL REMOVED]'
      );
      blocks.push({
        category: 'url',
        originalSnippet: content.url!,
        maskedSnippet: '[PRIVATE URL REMOVED]',
        reason: urlCheck.reason || 'Sensitive URL',
      });
      content.url = undefined;
    }

    return {
      ...content,
      filteredText,
      privacyBlocks: blocks,
    };
  }

  private fallbackRead(): ScreenContent {
    return {
      rawText: '',
      filteredText: '',
      appName: 'fallback',
      windowTitle: '',
      visibleElements: [],
      privacyBlocks: [],
      timestamp: new Date(),
    };
  }

  getLastContent(): ScreenContent | null {
    return this.lastContent;
  }

  async dispose(): Promise<void> {
    for (const worker of this.ocrWorkers) {
      if (worker) {
        await worker.terminate();
        getLogger().info('Tesseract OCR worker terminated');
      }
    }
    this.ocrWorkers = [];
  }
}
