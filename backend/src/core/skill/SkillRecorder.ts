/**
 * Skill Recorder — logs every skill invocation and learns which skills are
 * hot (frequent, slow, repeatedly corrected) so the compiler can promote
 * them to native. Output feeds the plan tiering service too.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SkillInvocation {
  skill: string;
  startedAt: number;
  durationMs: number;
  tokens?: number;
  corrected?: boolean;
  result: 'success' | 'error';
}

export interface SkillStats {
  skill: string;
  invocations: number;
  avgDurationMs: number;
  p95DurationMs: number;
  errorRate: number;
  correctionRate: number;
  totalTokens: number;
  lastInvokedAt: number;
  hotScore: number;
}

export interface SkillRecorderOptions {
  dataDir: string;
  windowMs?: number;
}

export class SkillRecorder {
  private dataDir: string;
  private windowMs: number;
  private recent: SkillInvocation[] = [];

  constructor(options: SkillRecorderOptions) {
    this.dataDir = options.dataDir;
    this.windowMs = options.windowMs ?? 7 * 24 * 60 * 60 * 1000;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.recent = this.load();
  }

  record(invocation: SkillInvocation): void {
    this.recent.push(invocation);
    this.recent = this.recent.filter(i => i.startedAt > Date.now() - this.windowMs);
    this.save();
  }

  stats(): SkillStats[] {
    const bySkill = new Map<string, SkillInvocation[]>();
    for (const inv of this.recent) {
      if (!bySkill.has(inv.skill)) bySkill.set(inv.skill, []);
      bySkill.get(inv.skill)!.push(inv);
    }

    const out: SkillStats[] = [];
    for (const [skill, invs] of bySkill.entries()) {
      const durations = invs.map(i => i.durationMs).sort((a, b) => a - b);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
      const errors = invs.filter(i => i.result === 'error').length;
      const corrected = invs.filter(i => i.corrected).length;
      const tokens = invs.reduce((a, i) => a + (i.tokens || 0), 0);
      // Hot = frequent + slow + error-prone (a native rewrite is worth it).
      const hotScore =
        invs.length * 0.4 +
        (avg / 1000) * 5 +
        (corrected / Math.max(1, invs.length)) * 30 +
        (errors / Math.max(1, invs.length)) * 20;
      out.push({
        skill,
        invocations: invs.length,
        avgDurationMs: Math.round(avg),
        p95DurationMs: p95,
        errorRate: errors / invs.length,
        correctionRate: corrected / invs.length,
        totalTokens: tokens,
        lastInvokedAt: Math.max(...invs.map(i => i.startedAt)),
        hotScore: Math.round(hotScore * 100) / 100,
      });
    }
    return out.sort((a, b) => b.hotScore - a.hotScore);
  }

  /** Skills whose hot score crosses the threshold. */
  hotSkills(threshold = 20): string[] {
    return this.stats().filter(s => s.hotScore >= threshold).map(s => s.skill);
  }

  private load(): SkillInvocation[] {
    const file = path.join(this.dataDir, 'skill-log.json');
    try {
      if (!fs.existsSync(file)) return [];
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(path.join(this.dataDir, 'skill-log.json'), JSON.stringify(this.recent));
    } catch {
      // Non-fatal: recording is best-effort.
    }
  }
}
