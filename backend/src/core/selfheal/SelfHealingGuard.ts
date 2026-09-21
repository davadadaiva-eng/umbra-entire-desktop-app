import { VirtualDisplayManager } from '../workspace/VirtualDisplayManager';
import { InputGuard } from '../workspace/InputGuard';
import { LLMConnector, LLMMessage } from '../agent/LLMConnector';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';

export interface AnomalyReport {
  detected: boolean;
  type: 'freeze' | 'modal' | 'crash' | 'loading' | 'unknown' | null;
  confidence: number;
  description: string;
  suggestedRecovery: string[];
  displayId: number;
  timestamp: Date;
}

export class SelfHealingGuard {
  private displayManager: VirtualDisplayManager;
  private inputGuard: InputGuard;
  private llm?: LLMConnector;
  private checkInterval: number = 5000;
  private lastFrameHashes: Map<number, string> = new Map();
  private freezeThreshold: number = 3;
  private freezeCounts: Map<number, number> = new Map();
  private everChanged: Map<number, boolean> = new Map();
  private enabled: boolean = false;
  private timer?: NodeJS.Timeout;

  constructor(
    displayManager: VirtualDisplayManager,
    inputGuard: InputGuard
  ) {
    this.displayManager = displayManager;
    this.inputGuard = inputGuard;
  }

  setLLM(llm: LLMConnector): void {
    this.llm = llm;
  }

  start(intervalMs?: number): void {
    if (intervalMs) this.checkInterval = intervalMs;
    this.enabled = true;
    this.timer = setInterval(() => this.healthCheck(), this.checkInterval);
    getLogger().info({ interval: this.checkInterval }, 'Self-healing guard started');
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    getLogger().info('Self-healing guard stopped');
  }

  private async healthCheck(): Promise<void> {
    if (!this.enabled) return;

    const displays = this.displayManager.getAllDisplays();
    for (const display of displays) {
      try {
        const report = await this.analyzeDisplay(display.id);
        if (report.detected) {
          getLogger().warn({ displayId: display.id, type: report.type }, 'Anomaly detected');
          await this.recover(display.id, report);
        }
      } catch (err: any) {
        getLogger().debug({ displayId: display.id, err: err.message }, 'Health check error');
      }
    }
  }

  private async analyzeDisplay(displayId: number): Promise<AnomalyReport> {
    const buffer = await this.displayManager.capture(displayId);
    if (!buffer) {
      return {
        detected: false, type: null, confidence: 0, description: 'No frame data',
        suggestedRecovery: [], displayId, timestamp: new Date(),
      };
    }

    const frameHash = this.hashFrame(buffer);
    const previousHash = this.lastFrameHashes.get(displayId);

    if (previousHash !== undefined) {
      if (previousHash === frameHash) {
        const count = (this.freezeCounts.get(displayId) || 0) + 1;
        this.freezeCounts.set(displayId, count);

        if (count >= this.freezeThreshold && this.everChanged.get(displayId)) {
          return {
            detected: true,
            type: 'freeze',
            confidence: 85,
            description: `Display ${displayId} appears frozen (${count} identical frames)`,
            suggestedRecovery: ['click_escape', 'wait_2000ms', 'click_escape'],
            displayId,
            timestamp: new Date(),
          };
        }
      } else {
        this.freezeCounts.set(displayId, 0);
        this.everChanged.set(displayId, true);
      }
    }

    this.lastFrameHashes.set(displayId, frameHash);

    if (this.llm && Math.random() < 0.1) {
      return this.vlmAnomalyCheck(displayId, buffer);
    }

    return {
      detected: false, type: null, confidence: 0, description: 'OK',
      suggestedRecovery: [], displayId, timestamp: new Date(),
    };
  }

  private async vlmAnomalyCheck(displayId: number, buffer: Buffer): Promise<AnomalyReport> {
    if (!this.llm) return this.emptyReport(displayId);

    try {
      const base64 = buffer.toString('base64');
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: 'You are a UI anomaly detector. Analyze this screenshot of an automated desktop.\nRespond with JSON: {"anomaly": false} or {"anomaly": true, "type": "freeze|modal|crash|loading", "confidence": 0-100, "description": "...", "recovery": ["action1", "action2"]}',
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Analyze this desktop screenshot for anomalies' }, { type: 'image', image: base64, detail: 'low' }],
        },
      ];

      const result = await this.llm.complete(messages, 'vision', { temperature: 0.1 });
      const parsed = JSON.parse(result.content);

      if (parsed.anomaly) {
        return {
          detected: true,
          type: parsed.type || 'unknown',
          confidence: parsed.confidence || 50,
          description: parsed.description || 'VLM detected anomaly',
          suggestedRecovery: parsed.recovery || [],
          displayId,
          timestamp: new Date(),
        };
      }
    } catch {
      getLogger().debug({ displayId }, 'VLM anomaly check failed');
    }

    return this.emptyReport(displayId);
  }

  private emptyReport(displayId: number): AnomalyReport {
    return {
      detected: false, type: null, confidence: 0, description: 'OK',
      suggestedRecovery: [], displayId, timestamp: new Date(),
    };
  }

  private async recover(displayId: number, report: AnomalyReport): Promise<boolean> {
    getLogger().info({ displayId, type: report.type }, 'Attempting recovery');

    const recoveryMap: Record<string, string[]> = {
      modal: ['Escape', 'Escape', 'Enter'],
      freeze: ['Escape', 'wait:2000', 'Escape', 'Alt+F4'],
      loading: ['wait:5000', 'Escape'],
      crash: ['Alt+F4', 'wait:3000'],
      unknown: ['Escape', 'wait:2000', 'Escape'],
    };

    const actions = (report.type && recoveryMap[report.type]) || recoveryMap.unknown;
    let success = false;

    for (const action of actions) {
      try {
        if (action.startsWith('wait:')) {
          const ms = parseInt(action.split(':')[1], 10);
          await new Promise(r => setTimeout(r, ms));
        } else if (action === 'Alt+F4') {
          await this.inputGuard.sendSyntheticInput(displayId, {
            type: 'key', key: 'Alt+F4',
          });
          await new Promise(r => setTimeout(r, 1000));
        } else {
          await this.inputGuard.sendSyntheticInput(displayId, {
            type: 'key', key: action,
          });
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err: any) {
        getLogger().debug({ action, err: err.message }, 'Recovery action failed');
      }
    }

    await new Promise(r => setTimeout(r, 2000));

    const postBuffer = await this.displayManager.capture(displayId);
    if (postBuffer) {
      const postHash = this.hashFrame(postBuffer);
      const preHash = this.lastFrameHashes.get(displayId);
      success = postHash !== preHash;
    }

    if (success) {
      this.freezeCounts.set(displayId, 0);
      this.everChanged.set(displayId, true);
      eventBus.emit('healing:recovered', displayId.toString());
      getLogger().info({ displayId, type: report.type }, 'Recovery successful');
    } else {
      eventBus.emit('healing:failed', displayId.toString(), report.type || 'unknown');
      getLogger().error({ displayId, type: report.type }, 'Recovery failed');
    }

    return success;
  }

  async heal(stepDescription: string): Promise<boolean> {
    const displays = this.displayManager.getAllDisplays();
    if (displays.length === 0) return false;
    const displayId = displays[0].id;

    const report: AnomalyReport = {
      detected: true,
      type: 'unknown',
      confidence: 60,
      description: `Healing triggered for: ${stepDescription}`,
      suggestedRecovery: ['Escape', 'wait:2000', 'Escape'],
      displayId,
      timestamp: new Date(),
    };

    return this.recover(displayId, report);
  }

  private hashFrame(buffer: Buffer): string {
    let hash = 0;
    const step = Math.max(1, Math.floor(buffer.length / 1024));
    for (let i = 0; i < buffer.length; i += step) {
      hash = ((hash << 5) - hash) + buffer[i];
      hash |= 0;
    }
    return hash.toString(16);
  }
}
