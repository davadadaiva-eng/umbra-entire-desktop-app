import { VectorMemory, UserActivity } from '../memory/VectorMemory';
import { KnowledgeGraph } from '../../knowledge/KnowledgeGraph';
import { PrivacyGuard } from '../privacy/PrivacyGuard';
import { ScreenReader, ScreenContent } from '../vision/ScreenReader';
import { ContextSummary } from '../vision/ContentAnalyzer';
import { getLogger } from '../Logger';
import * as fs from 'fs';
import * as path from 'path';

let sessionCounter = 0;

export interface WatchConfig {
  pollIntervalMs: number;
  captureIntervalMs: number;
  idleThresholdSec: number;
  enableKeystrokeTracking: boolean;
  enableClickTracking: boolean;
  useScreenReader: boolean;
}

export class ActivityWatcher {
  private recall: VectorMemory;
  private knowledge: KnowledgeGraph;
  private privacy: PrivacyGuard;
  private screenReader: ScreenReader;
  private config: WatchConfig;
  private sessionId: string;
  private timer: NodeJS.Timeout | null = null;
  private captureTimer: NodeJS.Timeout | null = null;
  private enabled: boolean = false;

  private currentApp: string = '';
  private currentTitle: string = '';
  private currentUrl: string = '';
  private currentFile: string = '';
  private lastActivityTime: number = Date.now();
  private activityBuffer: Omit<UserActivity, 'id' | 'createdAt'>[] = [];

  private keystrokeAccum: number = 0;
  private clickAccum: number = 0;
  private scrollAccum: number = 0;
  private sessionDuration: number = 0;
  private seenApps: Set<string> = new Set();

  private lastContextSummary: ContextSummary | null = null;
  private lastScreenContent: ScreenContent | null = null;

  private screenshotsDir: string = '';
  private ocrQueue: Buffer[] = [];
  private vlmQueue: { buffer: Buffer; ocrText: string }[] = [];
  private ocrBusy: number = 0;
  private vlmBusy: number = 0;
  private screenshotCount: number = 0;

  private readonly OCR_POOL_SIZE: number = 2;
  private readonly OCR_QUEUE_CAP: number = 8;
  private readonly VLM_CONCURRENCY: number = 2;
  private readonly VLM_QUEUE_CAP: number = 6;

  constructor(
    recall: VectorMemory,
    knowledge: KnowledgeGraph,
    privacy: PrivacyGuard,
    screenReader: ScreenReader,
    config?: Partial<WatchConfig>,
  ) {
    this.recall = recall;
    this.knowledge = knowledge;
    this.privacy = privacy;
    this.screenReader = screenReader;
    this.config = {
      pollIntervalMs: 2000,
      captureIntervalMs: 2000,
      idleThresholdSec: 120,
      enableKeystrokeTracking: true,
      enableClickTracking: true,
      useScreenReader: true,
      ...config,
    };
    this.sessionId = `session-${Date.now()}-${++sessionCounter}`;
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.lastActivityTime = Date.now();
    this.sessionId = `session-${Date.now()}-${++sessionCounter}`;

    this.screenshotsDir = path.join(require('os').homedir(), '.umbra', 'screenshots', this.sessionId);
    fs.mkdirSync(this.screenshotsDir, { recursive: true });

    this.recall.startSession(this.sessionId);

    this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);

    if (this.config.useScreenReader) {
      this.screenReader.warmup().catch(() => {});
      this.captureTimer = setInterval(() => this.captureAndOcr(), this.config.captureIntervalMs);
      getLogger().info({ interval: this.config.captureIntervalMs }, 'Screen capture active');
    }

    getLogger().info({ sessionId: this.sessionId }, 'Activity watcher started (OCR mode)');
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
    this.flushBuffer();
    this.recall.endSession(this.sessionId, this.sessionDuration, this.seenApps.size);
    this.screenReader.dispose().catch(() => {});
  }

  injectActivity(activity: Partial<Omit<UserActivity, 'id' | 'createdAt'>>): void {
    const entry: Omit<UserActivity, 'id' | 'createdAt'> = {
      appName: activity.appName || this.currentApp || 'unknown',
      windowTitle: activity.windowTitle || this.currentTitle || '',
      action: activity.action || 'injected',
      targetUrl: activity.targetUrl || this.currentUrl || undefined,
      targetFile: activity.targetFile || this.currentFile || undefined,
      targetPath: activity.targetPath || undefined,
      contextTags: activity.contextTags || '',
      durationSec: activity.durationSec || 0,
      keystrokeCount: activity.keystrokeCount || 0,
      clickCount: activity.clickCount || 0,
      scrollCount: activity.scrollCount || 0,
      isActive: activity.isActive ?? true,
      sessionId: this.sessionId,
      hourOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
    };

    this.activityBuffer.push(entry);
    if (this.activityBuffer.length >= 10) this.flushBuffer();
  }

  recordKeystroke(): void {
    if (!this.config.enableKeystrokeTracking) return;
    this.keystrokeAccum++;
    this.lastActivityTime = Date.now();
  }

  recordClick(): void {
    if (!this.config.enableClickTracking) return;
    this.clickAccum++;
    this.lastActivityTime = Date.now();
  }

  recordScroll(): void {
    this.scrollAccum++;
    this.lastActivityTime = Date.now();
  }

  // ─── Fast Poll (lightweight, every 2s) ─────────────────────

  private poll(): void {
    try {
      const focusedInfo = this.getForegroundAppInfo();
      if (!focusedInfo) return;

      const privacyCheck = this.privacy.inspectApp(focusedInfo.appName);
      const urlCheck = focusedInfo.url ? this.privacy.inspectUrl(focusedInfo.url) : { allowed: true };
      const titleCheck = this.privacy.inspectWindowTitle(focusedInfo.windowTitle);

      const isPrivateApp = !privacyCheck.allowed || !urlCheck.allowed;

      if (isPrivateApp) {
        this.currentApp = '[PRIVATE]';
        this.currentTitle = '[PRIVATE]';
        this.keystrokeAccum = 0;
        this.clickAccum = 0;
        this.scrollAccum = 0;
        this.lastActivityTime = Date.now();
        return;
      }

      const now = Date.now();
      const durationSec = Math.floor((now - this.lastActivityTime) / 1000);
      const isActive = (now - this.lastActivityTime) < (this.config.idleThresholdSec * 1000);

      this.sessionDuration += this.config.pollIntervalMs / 1000;
      this.seenApps.add(focusedInfo.appName);

      const contextTags = this.inferContextTags(focusedInfo);
      const blockKeys = privacyCheck.blockKeystrokes || titleCheck.blockKeystrokes;
      const maskedTitle = this.privacy.maskWindowTitle(focusedInfo.windowTitle);

      const entry: Omit<UserActivity, 'id' | 'createdAt'> = {
        appName: focusedInfo.appName,
        windowTitle: maskedTitle,
        action: focusedInfo.appName !== this.currentApp ? 'focus' : 'active',
        targetUrl: focusedInfo.url || undefined,
        targetFile: focusedInfo.filePath ? this.privacy.filterSensitiveData(focusedInfo.filePath) : undefined,
        targetPath: focusedInfo.filePath ? this.privacy.filterSensitiveData(this.extractDir(focusedInfo.filePath)) : undefined,
        contextTags,
        durationSec,
        keystrokeCount: blockKeys ? 0 : this.keystrokeAccum,
        clickCount: this.clickAccum,
        scrollCount: this.scrollAccum,
        isActive,
        sessionId: this.sessionId,
        hourOfDay: new Date().getHours(),
        dayOfWeek: new Date().getDay(),
      };

      if (focusedInfo.appName !== this.currentApp) this.detectContextSwitch(entry);

      this.currentApp = focusedInfo.appName;
      this.currentTitle = focusedInfo.windowTitle;
      this.currentUrl = focusedInfo.url || '';
      this.currentFile = focusedInfo.filePath || '';

      this.activityBuffer.push(entry);
      if (this.activityBuffer.length >= 5) this.flushBuffer();

      this.keystrokeAccum = 0;
      this.clickAccum = 0;
      this.scrollAccum = 0;
      this.lastActivityTime = now;
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'Poll error');
    }
  }

  // ─── Capture + OCR (every 2s, parallel pool) ──────────────

  private captureBusy: boolean = false;

  private async captureAndOcr(): Promise<void> {
    if (this.captureBusy) return;
    this.captureBusy = true;
    try {
      const shot = await this.captureScreen();
      if (!shot) return;
      const { full, small, rect } = shot;

      const filepath = path.join(this.screenshotsDir, `ss-${Date.now()}.png`);
      fs.writeFileSync(filepath, full);
      this.screenshotCount++;

      if (rect.w > 0 && rect.h > 0) {
        getLogger().debug({ rect: `${rect.x},${rect.y},${rect.w},${rect.h}` }, 'Region capture');
      }

      this.ocrQueue.push(small);
      if (this.ocrQueue.length > this.OCR_QUEUE_CAP) {
        this.ocrQueue.splice(0, this.ocrQueue.length - this.OCR_QUEUE_CAP);
      }
      this.drainOcrQueue();
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'Capture error');
    } finally {
      this.captureBusy = false;
    }
  }

  private drainOcrQueue(): void {
    while (this.ocrBusy < this.OCR_POOL_SIZE && this.ocrQueue.length > 0) {
      const buffer = this.ocrQueue.shift()!;
      this.ocrBusy++;
      this.processOcr(buffer)
        .catch(() => {})
        .finally(() => {
          this.ocrBusy--;
          this.drainOcrQueue();
        });
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
  }

  private async processOcr(screenshotBuffer: Buffer): Promise<void> {
    const rawText = await this.withTimeout(
      this.screenReader.ocrImage(screenshotBuffer), 20000,
    );
    if (!rawText) return;

    const content = this.screenReader.buildBasicContent(rawText);
    this.lastScreenContent = content;

    this.recall.saveScreenSnapshot({
      appName: 'screen',
      windowTitle: '',
      filteredText: content.filteredText,
      contextTags: '',
      privacyBlocks: content.privacyBlocks.length,
      sessionId: this.sessionId,
    });

    this.recall.logUserActivity({
      appName: 'screen',
      windowTitle: '',
      action: 'ocr',
      contextTags: '',
      durationSec: 2,
      keystrokeCount: 0,
      clickCount: 0,
      scrollCount: 0,
      isActive: true,
      sessionId: this.sessionId,
      hourOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
    });

    this.vlmQueue.push({ buffer: screenshotBuffer, ocrText: rawText });
    if (this.vlmQueue.length > this.VLM_QUEUE_CAP) {
      this.vlmQueue.splice(0, this.vlmQueue.length - this.VLM_QUEUE_CAP);
    }
    this.drainVlmQueue();
  }

  private drainVlmQueue(): void {
    while (this.vlmBusy < this.VLM_CONCURRENCY && this.vlmQueue.length > 0) {
      const item = this.vlmQueue.shift()!;
      this.vlmBusy++;
      this.enrichWithVlm(item.buffer, item.ocrText)
        .catch(() => {})
        .finally(() => {
          this.vlmBusy--;
          this.drainVlmQueue();
        });
    }
  }

  private async enrichWithVlm(screenshotBuffer: Buffer, ocrText: string): Promise<void> {
    const t0 = Date.now();
    try {
      const enrichment = await this.withTimeout(
        this.screenReader.enrichContext(screenshotBuffer, ocrText), 45000,
      );
      getLogger().info({ app: enrichment.appName, ms: Date.now() - t0 }, 'VLM enrichment done');

      const filteredContent = this.screenReader.buildBasicContent(ocrText);

      const context: ContextSummary = {
        screenContent: filteredContent,
        taskContext: {
          domain: enrichment.appName,
          description: ocrText.substring(0, 200),
          urgency: 'low',
          currentTools: enrichment.appName ? [enrichment.appName] : [],
          detectedIntent: 'browsing',
        },
        learnedPatterns: [],
        suggestedActions: [],
        privacySummary: {
          blocksCount: filteredContent.privacyBlocks.length,
          categories: [...new Set(filteredContent.privacyBlocks.map(b => b.category))],
        },
      };
      this.lastContextSummary = context;

      const contextTags = [enrichment.appName !== 'screen' ? enrichment.appName : '', enrichment.url || '']
        .filter(Boolean).join(',');

      this.recall.saveScreenSnapshot({
        appName: enrichment.appName || 'screen',
        windowTitle: enrichment.windowTitle || '',
        targetUrl: enrichment.url,
        filteredText: filteredContent.filteredText,
        contextTags,
        privacyBlocks: filteredContent.privacyBlocks.length,
        sessionId: this.sessionId,
      });

      this.recall.logUserActivity({
        appName: enrichment.appName || 'screen',
        windowTitle: this.privacy.maskWindowTitle(enrichment.windowTitle || ''),
        action: 'vlm_ocr',
        targetUrl: enrichment.url,
        contextTags,
        durationSec: 2,
        keystrokeCount: 0,
        clickCount: 0,
        scrollCount: 0,
        isActive: true,
        sessionId: this.sessionId,
        hourOfDay: new Date().getHours(),
        dayOfWeek: new Date().getDay(),
      });

    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'VLM enrichment error');
    }
  }

  private async updateKnowledgeFromContext(context: ContextSummary): Promise<void> {
    try {
      const taskCtx = context.taskContext;
      const patterns = context.learnedPatterns;

      if (patterns.length > 0) {
        const patternKey = patterns.join('_').substring(0, 40);
        this.recall.savePattern({
          patternType: 'workflow_pattern',
          patternJson: patterns.join(' -> '),
          frequency: 1,
          confidence: 0.5,
          lastSeen: new Date(),
          suggestedKeyword: patternKey,
          knowledgeNodeId: undefined,
        });
      }

      const existing = await this.knowledge.getNode('learned/current-context');
      const content = `# Current Context\n\n## Domain\n${taskCtx.domain}\n\n## Intent\n${taskCtx.detectedIntent}\n\n## Urgency\n${taskCtx.urgency}\n\n## Tools\n${taskCtx.currentTools.join(', ')}\n\n## Privacy Blocks\n${context.privacySummary.blocksCount} blocked\n\nLast updated: ${new Date().toISOString()}`;

      if (!existing) {
        await this.knowledge.addOrUpdate(
          'learned/current-context',
          'Current Session Context',
          content,
          [...patterns, 'live', 'context'],
          ['index'],
          'system',
        );
      }
    } catch { }
  }

  async analyzePatterns(): Promise<void> {
    const patterns = this.recall.getUserActivityPatterns(60);
    if (patterns.appSequence.length < 3) return;

    const appSequence = patterns.appSequence.join(' -> ');
    const existingPatterns = this.recall.getHighConfidencePatterns(1);
    const isNew = !existingPatterns.some(p => p.patternJson === appSequence);

    if (isNew && patterns.appSequence.length >= 3) {
      const keyword = patterns.topApps.slice(0, 3).map(a => a.replace(/[^a-z0-9]/g, '_')).join('_').substring(0, 40);

      this.recall.savePattern({
        patternType: 'app_sequence',
        patternJson: appSequence,
        frequency: 1,
        confidence: 0.4,
        lastSeen: new Date(),
        suggestedKeyword: keyword,
        knowledgeNodeId: undefined,
      });

      if (patterns.appSequence.length >= 5) {
        await this.createKnowledgeNodeFromPattern(patterns, keyword);
      }
    }
  }

  private async createKnowledgeNodeFromPattern(
    patterns: { appSequence: string[]; topApps: string[]; currentContext: string },
    keyword: string,
  ): Promise<void> {
    const nodeId = `learned/workflow-${keyword}`;
    const existing = await this.knowledge.getNode(nodeId);
    if (existing) return;

    const tags = patterns.topApps.map(a => a.toLowerCase().replace(/[^a-z0-9]/g, '_'));
    const content = `# Learned Workflow: ${keyword}\n\n## App Sequence\n${patterns.appSequence.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n## Context\n${patterns.currentContext}\n\n## When to use\nWhenever working with ${patterns.topApps.join(', ')}.\n\n*Auto-generated from activity + screen reading.*`;

    await this.knowledge.addOrUpdate(
      nodeId,
      `Workflow: ${keyword}`,
      content,
      [...tags, 'learned', 'workflow', 'auto-generated'],
      ['index', 'learned/workflows'],
      'workflow',
    );
  }

  private detectContextSwitch(entry: Omit<UserActivity, 'id' | 'createdAt'>): void {
    const app = entry.appName.toLowerCase();

    const contextMap: Record<string, { action: string; tags: string }> = {
      code: { action: 'coding', tags: 'coding,development' },
      cursor: { action: 'coding', tags: 'coding,development' },
      vscode: { action: 'coding', tags: 'coding,development' },
      webstorm: { action: 'coding', tags: 'coding,development' },
      sublime_text: { action: 'coding', tags: 'coding,development' },
      chrome: { action: 'browsing', tags: 'browsing,web' },
      firefox: { action: 'browsing', tags: 'browsing,web' },
      edge: { action: 'browsing', tags: 'browsing,web' },
      brave: { action: 'browsing', tags: 'browsing,web' },
      terminal: { action: 'terminal', tags: 'terminal,cli' },
      powershell: { action: 'terminal', tags: 'terminal,cli' },
      cmd: { action: 'terminal', tags: 'terminal,cli' },
      windows_terminal: { action: 'terminal', tags: 'terminal,cli' },
      slack: { action: 'communicating', tags: 'communication' },
      discord: { action: 'communicating', tags: 'communication' },
      teams: { action: 'communicating', tags: 'communication' },
      zoom: { action: 'communicating', tags: 'communication' },
      whatsapp: { action: 'communicating', tags: 'communication' },
      outlook: { action: 'email', tags: 'email,communication' },
      thunderbird: { action: 'email', tags: 'email,communication' },
      spotify: { action: 'media', tags: 'media,music' },
    };

    for (const [key, val] of Object.entries(contextMap)) {
      if (app.includes(key)) {
        this.injectActivity({ appName: entry.appName, action: val.action, contextTags: val.tags });
        break;
      }
    }
  }

  private flushBuffer(): void {
    if (this.activityBuffer.length === 0) return;
    const batch = this.activityBuffer.splice(0);
    for (const entry of batch) {
      this.recall.logUserActivity(entry);
    }
  }

  private getForegroundAppInfo(): { appName: string; windowTitle: string; url?: string; filePath?: string } | null {
    try {
      const native = require('../../native/win32/WindowNative');
      return native.getForegroundWindowInfo();
    } catch {
      return { appName: 'desktop', windowTitle: '', url: 'https://example.com', filePath: process.cwd() };
    }
  }

  private capScriptWritten: string = '';

  private captureScreen(): Promise<{ full: Buffer; small: Buffer; rect: { x: number; y: number; w: number; h: number } } | null> {
    const scriptPath = path.join(require('os').homedir(), '.umbra', 'tmp', 'cap.ps1');
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class W32{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[DllImport("user32.dll")]public static extern int GetSystemMetrics(int i);public struct RECT{public int L;public int T;public int R;public int B;}}\'',
      '[W32]::SetProcessDPIAware()|Out-Null',
      '$sw=[W32]::GetSystemMetrics(0);$sh=[W32]::GetSystemMetrics(1)',
      '$b=New-Object System.Drawing.Bitmap $sw,$sh',
      '$sz=New-Object System.Drawing.Size($sw,$sh)',
      '$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen(0,0,0,0,$sz)',
      '$m=New-Object System.IO.MemoryStream;$b.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);$full=[System.Convert]::ToBase64String($m.ToArray());$m.Dispose()',
      '$rx=0;$ry=0;$rw=0;$rh=0',
      '$hwnd=[W32]::GetForegroundWindow()',
      'if($hwnd -ne [IntPtr]::Zero){$r=New-Object W32+RECT;[W32]::GetWindowRect($hwnd,[ref]$r)|Out-Null;$rx=[Math]::Max($r.L,0);$ry=[Math]::Max($r.T,0);$x2=[Math]::Min($r.R,$sw);$y2=[Math]::Min($r.B,$sh);$rw=$x2-$rx;$rh=$y2-$ry}',
      '$src=$b;$ox=0;$oy=0;$ow=$sw;$oh=$sh',
      'if($rw -gt 100 -and $rh -gt 100 -and ($rw -lt $sw -or $rh -lt $sh)){$crop=New-Object System.Drawing.Rectangle($rx,$ry,$rw,$rh);$src=$b.Clone($crop,$b.PixelFormat);$ow=$rw;$oh=$rh}else{$rx=0;$ry=0;$rw=0;$rh=0}',
      '$w=[int]($ow*0.75);$h=[int]($oh*0.75)',
      '$b2=New-Object System.Drawing.Bitmap $w,$h;$g2=[System.Drawing.Graphics]::FromImage($b2);$g2.InterpolationMode=\'HighQualityBicubic\';$g2.DrawImage($src,0,0,$w,$h)',
      '$m2=New-Object System.IO.MemoryStream;$b2.Save($m2,[System.Drawing.Imaging.ImageFormat]::Png);$small=[System.Convert]::ToBase64String($m2.ToArray());$m2.Dispose()',
      '$g.Dispose();$b.Dispose();$g2.Dispose();$b2.Dispose();$src.Dispose()',
      'Write-Output "FULL:$full"',
      'Write-Output "REGION:$small"',
      'Write-Output "RECT:$rx,$ry,$rw,$rh"',
    ].join('\n');
    if (this.capScriptWritten !== script) {
      fs.writeFileSync(scriptPath, script, 'utf-8');
      this.capScriptWritten = script;
    }

    return new Promise((resolve) => {
      require('child_process').exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 30000, encoding: 'utf-8', windowsHide: true, maxBuffer: 15 * 1024 * 1024 },
        (err: Error | null, stdout: string) => {
          if (err || !stdout) {
            if (err) getLogger().debug({ err: err.message }, 'captureScreen failed');
            resolve(null);
            return;
          }
          try {
            const lines = stdout.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
            const fullLine = lines.find((l: string) => l.startsWith('FULL:'));
            const regionLine = lines.find((l: string) => l.startsWith('REGION:'));
            const rectLine = lines.find((l: string) => l.startsWith('RECT:'));
            if (!fullLine || !regionLine) {
              resolve(null);
              return;
            }
            let rect = { x: 0, y: 0, w: 0, h: 0 };
            if (rectLine) {
              const parts = rectLine.slice(5).split(',').map((p: string) => parseInt(p, 10));
              if (parts.length === 4 && !parts.some((p: number) => isNaN(p))) {
                rect = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
              }
            }
            resolve({
              full: Buffer.from(fullLine.slice(5), 'base64'),
              small: Buffer.from(regionLine.slice(7), 'base64'),
              rect,
            });
          } catch (e: any) {
            getLogger().debug({ err: e.message }, 'captureScreen parse failed');
            resolve(null);
          }
        },
      );
    });
  }

  private inferContextTags(info: { appName: string; windowTitle: string }): string {
    const tags: string[] = [];
    const app = info.appName.toLowerCase();
    const title = info.windowTitle.toLowerCase();

    const map: Record<string, string[]> = {
      code: ['coding'], cursor: ['coding'], vscode: ['coding'],
      webstorm: ['coding'], sublime_text: ['coding'],
      chrome: ['web'], firefox: ['web'], edge: ['web'], brave: ['web'],
      slack: ['chat'], discord: ['chat'], teams: ['chat'],
      outlook: ['email'], thunderbird: ['email'],
      terminal: ['terminal'], powershell: ['terminal'], cmd: ['terminal'], windows_terminal: ['terminal'],
    };

    for (const [key, vals] of Object.entries(map)) {
      if (app.includes(key)) tags.push(...vals);
    }

    if (title.includes('github')) tags.push('github');
    if (title.includes('notion') || title.includes('docs')) tags.push('documentation');

    return [...new Set(tags)].join(',');
  }

  private extractDir(filePath: string): string {
    try { return require('path').dirname(filePath); }
    catch { return ''; }
  }

  // ─── Public API ────────────────────────────────────────────

  getLastContext(): ContextSummary | null { return this.lastContextSummary; }
  getLastScreenContent(): ScreenContent | null { return this.lastScreenContent; }
}
