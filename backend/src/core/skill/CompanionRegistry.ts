/**
 * CompanionRegistry — the "your team" layer: named, specialized agents
 * routed from the same 100-skill stack the rest of Umbra runs on.
 *
 * Each companion is a profile: a role, a personality line, a subset of
 * SkillStack skill ids it is allowed to run, a preferred model slot and an
 * allowed-tools list. Intents are scored by reusing SkillRouter (the exact
 * same trigger scoring the agent loop uses), so the companion that owns the
 * winning skill claims the task — no second scoring implementation to drift.
 *
 * The registry is a pure routing layer: it decides *who* runs; the existing
 * SkillStack/AgentRuntime machinery decides *how*. The default companion
 * ("assistant") is excluded from scoring and handles anything no specialist
 * claims, keeping the loop anonymous-safe.
 */
import { SkillRouter, RouteResult } from './SkillRouter';

export interface CompanionProfile {
  id: string;
  name: string;
  role: string;
  personality: string;
  /** Skill ids from the 100-skill stack this companion is allowed to run. */
  skills: string[];
  /** Preferred model slot ('fast' | 'reasoning' | 'frontend' | 'difficult'). */
  model?: string;
  /** Tool names the companion may invoke (mcp connectors, workspace, browser…). */
  tools?: string[];
}

/** The default team — one profile per headline role, mapped to real skill ids. */
export const DEFAULT_COMPANIONS: CompanionProfile[] = [
  {
    id: 'assistant',
    name: 'Umbra',
    role: 'General assistant',
    personality: 'Calm, direct, default handler for anything not claimed by a specialist.',
    skills: ['scheduling', 'reminders', 'task-triage', 'note-taking', 'doc-drafting', 'decision-briefing'],
    model: 'reasoning',
    tools: ['browser', 'workspace', 'mcp'],
  },
  {
    id: 'research',
    name: 'Scout',
    role: 'Research & competitive intel',
    personality: 'Gathers sources, cites everything, comes back with structure.',
    skills: ['web-research', 'paper-summarization', 'citation-manager', 'market-research', 'competitive-intel'],
    model: 'reasoning',
    tools: ['browser', 'workspace'],
  },
  {
    id: 'creative',
    name: 'Quill',
    role: 'Creative & content',
    personality: 'Drafts, iterates, learns your voice over time.',
    skills: ['copywriting', 'doc-drafting', 'brand-identity', 'image-generation', 'social-calendar', 'ui-critique'],
    model: 'frontend',
    tools: ['browser', 'workspace', 'mcp'],
  },
  {
    id: 'ops',
    name: 'Atlas',
    role: 'Operations & productivity',
    personality: 'Keeps the calendar, the inbox and the open loops moving.',
    skills: ['scheduling', 'reminders', 'task-triage', 'email-triage', 'meeting-prep', 'inbox-zero', 'note-taking'],
    model: 'fast',
    tools: ['workspace', 'mcp'],
  },
  {
    id: 'sales',
    name: 'Mercury',
    role: 'Sales & outreach',
    personality: 'Qualifies, drafts outreach, keeps the pipeline moving.',
    skills: ['lead-qualification', 'competitive-intel', 'campaign-planning', 'copywriting', 'decision-briefing'],
    model: 'reasoning',
    tools: ['browser', 'workspace', 'mcp'],
  },
];

export interface CompanionScore {
  profile: CompanionProfile;
  /** How strongly this companion owns the intent (0 = no claim). */
  score: number;
}

export interface CompanionRoute {
  /** The companion that should run the task (default when nothing claims it). */
  best: CompanionProfile;
  /** Every companion with a nonzero claim, best first. */
  ranked: CompanionScore[];
  /** The SkillRouter result the scoring was derived from. */
  routed: RouteResult;
  /** True when the intent matched a skill above the router's threshold. */
  direct: boolean;
}

export class CompanionRegistry {
  private profiles: CompanionProfile[];
  private router: SkillRouter;
  private fallback: CompanionProfile;

  constructor(profiles?: CompanionProfile[], options?: { fallbackThreshold?: number }) {
    this.profiles = profiles && profiles.length > 0 ? profiles : DEFAULT_COMPANIONS;
    this.router = new SkillRouter(options?.fallbackThreshold);
    this.fallback = this.profiles.find(p => p.id === 'assistant') ?? this.profiles[0];
  }

  /** The full roster (copies, so callers cannot mutate the registry). */
  list(): CompanionProfile[] {
    return this.profiles.map(p => ({ ...p, skills: [...p.skills], tools: p.tools ? [...p.tools] : undefined }));
  }

  byId(id: string): CompanionProfile | undefined {
    return this.profiles.find(p => p.id === id);
  }

  /**
   * Score every companion for an intent by reusing SkillRouter's trigger
   * scoring: owning the winning skill is worth the most, owning a candidate
   * a little. The default companion is excluded — it only runs when nothing
   * else claims the task.
   */
  scoreIntent(intent: string): CompanionRoute {
    const routed = this.router.route(intent);
    const ranked: CompanionScore[] = this.profiles
      .filter(p => p.id !== this.fallback.id)
      .map(profile => ({ profile, score: this.scoreProfile(profile, routed) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return {
      best: ranked[0] ? ranked[0].profile : this.fallback,
      ranked,
      routed,
      direct: routed.direct,
    };
  }

  /** The companion that should handle an intent (fallback when nothing claims it). */
  best(intent: string): CompanionProfile {
    return this.scoreIntent(intent).best;
  }

  private scoreProfile(profile: CompanionProfile, routed: RouteResult): number {
    const owned = new Set(profile.skills);
    // Profile skills are bare names ("web-research") while stack ids are
    // domain-prefixed ("research.web-research") — match both so ownership
    // resolves regardless of which form the profile was declared in.
    const owns = (id: string): boolean => owned.has(id) || owned.has(id.slice(id.indexOf('.') + 1));
    let score = 0;
    if (routed.skill && owns(routed.skill.id)) score += routed.score * 2;
    for (const candidate of routed.candidates) {
      if (owns(candidate.id)) score += 0.5;
    }
    return score;
  }
}
