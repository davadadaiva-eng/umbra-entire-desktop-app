/**
 * Skill Router — decides which skills run based on user intent. Uses trigger
 * keyword scoring, with the graphified context engine as a fallback path for
 * ambiguous requests.
 */

import { ALL_SKILLS, StackSkill, findSkill } from './SkillStack';

export interface RouteResult {
  skill?: StackSkill;
  candidates: StackSkill[];
  score: number;
  direct: boolean;
}

export class SkillRouter {
  constructor(private fallbackThreshold = 0.4) {}

  route(intent: string): RouteResult {
    const text = intent.toLowerCase();
    const scored = ALL_SKILLS
      .map(skill => ({ skill, score: this.score(skill, text) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);

    const candidates = scored.slice(0, 3).map(r => r.skill);
    const top = scored[0];
    if (top && top.score >= this.fallbackThreshold) {
      return { skill: top.skill, candidates, score: top.score, direct: true };
    }
    return { skill: undefined, candidates, score: top?.score ?? 0, direct: false };
  }

  byId(id: string): StackSkill | undefined {
    return findSkill(id);
  }

  private score(skill: StackSkill, text: string): number {
    let score = 0;
    for (const trigger of skill.triggers) {
      const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Anchor to word boundaries so 'mail' does not match inside 'email'.
      const matches = text.match(new RegExp(`\\b${escaped}\\b`, 'g'));
      if (matches) {
        // Longer, more specific trigger phrases dominate generic single words.
        score += trigger.length / 4 + matches.length;
      }
    }
    // Domain id as a weak signal.
    if (text.includes(skill.domain)) score += 0.5;
    return score;
  }
}
