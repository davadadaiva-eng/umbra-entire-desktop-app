import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getLogger } from '../Logger';
import { createHash } from 'crypto';
import { ActionProposal } from '../../types';

export interface ConsentConfig {
  dataDir: string;
  promptTimeoutMs: number;
  askOncePerSession: boolean;
  /** Skip all consent prompts — tasks run immediately without asking. Default: true (no y/n gate). */
  autoApprove: boolean;
}

export type ConsentResult = 'granted' | 'denied' | 'timeout';

export interface ProposalDecision {
  approved: boolean;
  hash: string;
}

export class ConsentGate {
  private config: ConsentConfig;
  private granted: boolean = false;
  private denied: boolean = false;
  private proposalsDir: string;

  constructor(config: Partial<ConsentConfig>) {
    this.config = {
      dataDir: path.join(process.env['USERPROFILE'] || '.', '.umbra'),
      promptTimeoutMs: 30000,
      askOncePerSession: true,
      autoApprove: false,
      ...config,
    };
    this.proposalsDir = path.join(this.config.dataDir, 'proposals');
    if (!fs.existsSync(this.proposalsDir)) {
      fs.mkdirSync(this.proposalsDir, { recursive: true });
    }
  }

  async request(reason: string): Promise<ConsentResult> {
    if (this.isEmergencyStopArmed()) return 'denied';
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

  /** Create an action proposal with SHA-256 hash for staleness detection. */
  async proposeAction(taskId: string, action: string, args: Record<string, unknown>): Promise<ActionProposal> {
    if (this.isEmergencyStopArmed()) throw new Error('Emergency stop is armed; cannot propose actions');
    const hash = this.computeHash(action, args);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes

    const proposal: ActionProposal = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      taskId,
      action,
      args,
      hash,
      status: 'awaiting_review',
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    await this.saveProposal(proposal);
    getLogger().info({ proposalId: proposal.id, taskId, action, hash }, 'Action proposed');
    return proposal;
  }

  /** Review a proposal — verifies hash matches to prevent stale approvals. */
  async reviewAction(proposalId: string, decision: ProposalDecision): Promise<{ success: boolean; proposal?: ActionProposal; error?: string }> {
    const proposal = await this.getProposal(proposalId);
    if (!proposal) {
      return { success: false, error: 'Proposal not found' };
    }

    // Check expiration
    if (new Date() > proposal.expiresAt) {
      proposal.status = 'expired';
      proposal.updatedAt = new Date();
      await this.saveProposal(proposal);
      return { success: false, error: 'Proposal expired' };
    }

    // Verify hash to prevent stale approval
    if (decision.hash !== proposal.hash) {
      getLogger().warn({ proposalId, expectedHash: proposal.hash, providedHash: decision.hash }, 'Hash mismatch — stale proposal');
      return { success: false, error: 'Hash mismatch — proposal may have been modified' };
    }

    proposal.status = decision.approved ? 'approved' : 'denied';
    proposal.updatedAt = new Date();
    await this.saveProposal(proposal);

    getLogger().info({ proposalId, approved: decision.approved }, 'Proposal reviewed');
    return { success: true, proposal };
  }

  /** Get a proposal by ID. */
  async getProposal(proposalId: string): Promise<ActionProposal | undefined> {
    const file = path.join(this.proposalsDir, `${proposalId}.json`);
    if (!fs.existsSync(file)) return undefined;
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const proposal = JSON.parse(raw) as ActionProposal;
      return {
        ...proposal,
        expiresAt: new Date(proposal.expiresAt),
        createdAt: new Date(proposal.createdAt),
        updatedAt: new Date(proposal.updatedAt),
      };
    } catch {
      return undefined;
    }
  }

  /** List all proposals for a task. */
  async listProposals(taskId: string): Promise<ActionProposal[]> {
    const files = fs.readdirSync(this.proposalsDir).filter(f => f.endsWith('.json'));
    const proposals: ActionProposal[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.proposalsDir, file), 'utf-8');
        const p = JSON.parse(raw) as ActionProposal;
        if (p.taskId === taskId) {
          proposals.push({
            ...p,
            expiresAt: new Date(p.expiresAt),
            createdAt: new Date(p.createdAt),
            updatedAt: new Date(p.updatedAt),
          });
        }
      } catch {
        // Skip corrupt files
      }
    }
    return proposals.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Compute SHA-256 hash of action + args for staleness detection. */
  private computeHash(action: string, args: Record<string, unknown>): string {
    const payload = JSON.stringify({ action, args });
    return createHash('sha256').update(payload).digest('hex');
  }

  private async saveProposal(proposal: ActionProposal): Promise<void> {
    const file = path.join(this.proposalsDir, `${proposal.id}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(proposal, null, 2), 'utf-8');
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
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
      try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
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
