import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getLogger } from '../Logger';

export interface ConsentConfig {
  dataDir: string;
  promptTimeoutMs: number;
  askOncePerSession: boolean;
  /** Skip all consent prompts — tasks run immediately without asking. Default: true (no y/n gate). */
  autoApprove: boolean;
}

export type ConsentResult = 'granted' | 'denied' | 'timeout';

export class ConsentGate {
  private config: ConsentConfig;
  private granted: boolean = false;
  private denied: boolean = false;

  constructor(config: Partial<ConsentConfig>) {
    this.config = {
      dataDir: path.join(process.env['USERPROFILE'] || '.', '.umbra'),
      promptTimeoutMs: 30000,
      askOncePerSession: true,
      autoApprove: true,
      ...config,
    };
  }

  async request(reason: string): Promise<ConsentResult> {
    if (this.denied) return 'denied';
    if (this.config.askOncePerSession && this.granted) return 'granted';
    // autoApprove or UMBRA_CONSENT_AUTOGRANT=1 — skip the prompt entirely
    if (this.config.autoApprove || process.env['UMBRA_CONSENT_AUTOGRANT'] === '1') {
      if (!this.granted) {
        this.granted = true;
        getLogger().debug({ reason }, 'Consent gate: auto-approved');
      }
      return 'granted';
    }

    getLogger().warn({ reason }, 'Consent gate: requesting user approval');

    const granted = await this.promptUser(reason);
    if (granted) {
      this.granted = true;
      this.denied = false;
      getLogger().info('Consent gate: granted');
      return 'granted';
    }
    this.denied = true;
    getLogger().warn('Consent gate: denied');
    return 'denied';
  }

  async checkEmergencyStop(): Promise<boolean> {
    return this.isEmergencyStopArmed();
  }

  isEmergencyStopArmed(): boolean {
    const file = path.join(this.config.dataDir, 'emergency-stop');
    return fs.existsSync(file);
  }

  armEmergencyStop(): void {
    const file = path.join(this.config.dataDir, 'emergency-stop');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, new Date().toISOString(), 'utf-8');
      getLogger().warn('Consent gate: emergency-stop armed');
    }
  }

  disarmEmergencyStop(): void {
    const file = path.join(this.config.dataDir, 'emergency-stop');
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch { }
    }
  }

  reset(): void {
    this.granted = false;
    this.denied = false;
  }

  isGranted(): boolean {
    return this.granted;
  }

  getState(): { granted: boolean; denied: boolean; askOncePerSession: boolean } {
    return {
      granted: this.granted,
      denied: this.denied,
      askOncePerSession: this.config.askOncePerSession,
    };
  }

  private promptUser(reason: string): Promise<boolean> {
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const text = `Umbra needs your permission to control the computer:\n  ${reason}\nType y to allow for this session, n to deny (auto-deny in ${Math.round(this.config.promptTimeoutMs / 1000)}s): `;

      let done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        rl.close();
        resolve(result);
      };

      rl.question(text, answer => {
        const a = String(answer || '').trim().toLowerCase();
        finish(a === 'y' || a === 'yes' || a === 's' || a === 'si');
      });

      const timer = setTimeout(() => {
        finish(false);
      }, this.config.promptTimeoutMs);

      rl.on('close', () => {
        finish(false);
      });
    });
  }
}
