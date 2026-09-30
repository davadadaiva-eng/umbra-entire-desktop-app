/**
 * ModelRouter — routes each LLM call to a task-appropriate model slot and
 * enforces a hard monthly *cost* budget, so hosted tokens never exceed what
 * the plan covers.
 *
 * Model slots (flagship defaults — plan downgrades live in pricing.ts):
 *   free       — cloud free models (OpenRouter `:free`); the spillover target.
 *   fast       — day-to-day quick work (Gemini 2.5 Flash).
 *   reasoning  — day-to-day agentic work (Kimi K3).
 *   frontend   — frontend/design work (Gemini 2.5 Flash).
 *   difficult  — hard tasks (Claude Sonnet 5).
 *
 * All prices, budgets, and model IDs live in ./pricing — the single source
 * of truth. This file only re-exports them under their historic names.
 *
 * The token-saving stack is baked into the cost model and activated with the
 * plan:
 *   - Prompt caching → a high `cacheHitRatio` discounts input tokens.
 *   - Graphify       → input context is compressed before the call (fewer
 *                      input tokens, measured from the provider's report).
 *   - Caveman        → dense, short outputs, capped at `maxOutputTokens`.
 * Cost is computed from *actual* input/output tokens reported by the provider,
 * so savings are real, not assumed.
 *
 * The router is a pure policy object: it never calls a provider. The
 * `RoutedLLMConnector` consults it before/after each completion and spills
 * over to the free slot whenever a paid slot's budget is exhausted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PlanTier, RoutingConfig, RoutingTier, UmbraConfig } from '../../types';
import { estimateTokens } from '../graphify/Caveman';
import {
  PLAN_PROFILES as PRICING_PLANS,
  MODELS as PRICING_MODELS,
  SLOT_DEFAULTS,
  OPENROUTER_ENDPOINT,
  CACHE_HIT_RATIO,
  type PlanProfile as PricingPlanProfile,
} from './pricing';

export type PlanProfile = PricingPlanProfile;

/**
 * The hosted plan ladder. Budgets are assigned automatically from the plan
 * (see pricing.ts — pro €5 models / €6.70 cloud, ultimate $10 / €10,
 * enterprise $30 / €29.99 + $15 telco).
 */
export const PLAN_PROFILES: Record<PlanTier, PlanProfile> = PRICING_PLANS;

/**
 * Default model slots. All slots ride OpenRouter (openai-compatible) on the
 * operator's single key. The free slot uses OpenRouter cloud free models so
 * spillover works without a local GPU.
 */
function slot(tier: RoutingTier): RoutingConfig[RoutingTier] {
  const def = SLOT_DEFAULTS[tier];
  const price = PRICING_MODELS[def.modelKey];
  return {
    provider: def.provider,
    model: price.id,
    ...(def.endpoint || tier === 'free' ? { endpoint: def.endpoint ?? OPENROUTER_ENDPOINT } : {}),
    inputPerM: price.inputPerM,
    cacheHitPerM: price.cacheReadPerM,
    outputPerM: price.outputPerM,
  };
}

export const DEFAULT_ROUTING: RoutingConfig = {
  enabled: false,
  cacheHitRatio: CACHE_HIT_RATIO,
  graphify: true,
  caveman: true,
  free: slot('free'),
  fast: slot('fast'),
  reasoning: slot('reasoning'),
  frontend: slot('frontend'),
  difficult: slot('difficult'),
};
export interface RouterUsage {
  date: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  /** USD spent per slot this month. */
  spent: Record<RoutingTier, number>;
}

export interface PlanOverview {
  tier: PlanTier;
  name: string;
  priceUsd: number;
  budgetUsd: number;
  models: Record<RoutingTier, string[]>;
  slotBudgets: Record<RoutingTier, number>;
}

export interface RouterSnapshot {
  plan: PlanTier;
  planName: string;
  monthlyPriceUsd: number;
  monthlyBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  hostedPlan: boolean;
  maxOutputTokens: number;
  enabled: boolean;
  optimizations: {
    promptCaching: boolean;
    cacheHitRatio: number;
    graphify: boolean;
    caveman: boolean;
  };
  tiers: Record<RoutingTier, { provider: string; model: string; endpoint?: string; inputPerM: number; cacheHitPerM: number; outputPerM: number }>;
  slotBudgets: Record<RoutingTier, number>;
  spentBySlot: Record<RoutingTier, number>;
  /** Every plan and its models/budgets, for UI reporting. */
  plans: PlanOverview[];
}

export interface ModelRouterOptions {
  config: UmbraConfig;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional JSON file for persisting spend counters across restarts. */
  persistPath?: string;
}

const TIERS: RoutingTier[] = ['free', 'fast', 'reasoning', 'frontend', 'difficult'];

const EMPTY_SPENT: Record<RoutingTier, number> = { free: 0, fast: 0, reasoning: 0, frontend: 0, difficult: 0 };

export class ModelRouter {
  private routing: RoutingConfig;
  private profile: PlanProfile;
  private tier: PlanTier;
  private now: () => Date;
  private persistPath?: string;
  private usage: RouterUsage;

  constructor(options: ModelRouterOptions) {
    this.routing = options.config.plan.routing ?? DEFAULT_ROUTING;
    this.tier = options.config.plan.tier ?? 'free';
    this.profile = PLAN_PROFILES[this.tier] ?? PLAN_PROFILES.free;
    this.now = options.now ?? (() => new Date());
    this.persistPath = options.persistPath;
    this.usage = this.loadUsage();
    this.rollover();
  }

  /** Re-read tier + routing from a (possibly changed) config. */
  updateConfig(config: UmbraConfig): void {
    this.routing = config.plan.routing ?? DEFAULT_ROUTING;
    this.tier = config.plan.tier ?? 'free';
    this.profile = PLAN_PROFILES[this.tier] ?? PLAN_PROFILES.free;
    this.rollover();
  }

  get enabled(): boolean {
    return this.routing.enabled;
  }

  get planTier(): PlanTier {
    return this.tier;
  }

  /** Free plan users run free models only; everyone else gets hosted slots. */
  planAllowsHosted(): boolean {
    return this.tier !== 'free';
  }

  /** Map an LLM role (+ optional task hint) to its model slot. */
  routeFor(role: 'reasoning' | 'vision' | 'fast', task?: 'general' | 'frontend' | 'difficult'): RoutingTier {
    if (task === 'frontend') return 'frontend';
    if (task === 'difficult') return 'difficult';
    if (role === 'reasoning') return 'reasoning';
    return 'fast';
  }

  /** The slot to actually run, after applying plan restrictions. */
  resolveTier(role: 'reasoning' | 'vision' | 'fast', task?: 'general' | 'frontend' | 'difficult'): RoutingTier {
    if (!this.planAllowsHosted()) return 'free';
    return this.routeFor(role, task);
  }

  tierConfig(tier: RoutingTier): RoutingConfig[RoutingTier] {
    return this.routing[tier];
  }

  maxOutputTokens(): number {
    return this.profile.maxOutputTokens;
  }

  /** Rough input-token estimate for a message list (same heuristic as metering). */
  estimateInput(messages: Array<{ content: string | unknown }>): number {
    return messages.reduce((acc, m) => {
      const content = typeof m.content === 'string' ? m.content : '';
      return acc + estimateTokens(content);
    }, 0);
  }

  /** Estimated USD cost for a slot, with prompt-caching already applied. */
  cost(tier: RoutingTier, inputTokens: number, outputTokens: number): number {
    const c = this.routing[tier];
    const hit = Math.min(1, Math.max(0, this.routing.cacheHitRatio));
    const inputCost = (inputTokens / 1_000_000) * (hit * c.cacheHitPerM + (1 - hit) * c.inputPerM);
    const outputCost = (outputTokens / 1_000_000) * c.outputPerM;
    return inputCost + outputCost;
  }

  /** True when a slot's token cost fits the plan's slot + total budgets. */
  canAffordTier(tier: RoutingTier, inputTokens: number, outputTokens: number): boolean {
    if (tier === 'free') return true;
    this.rollover();
    const cost = this.cost(tier, inputTokens, outputTokens);
    const slotBudget = this.profile.slotBudgetUsd[tier];
    if (slotBudget !== Infinity && this.usage.spent[tier] + cost > slotBudget) return false;
    if (this.profile.monthlyBudgetUsd !== Infinity && this.totalSpent() + cost > this.profile.monthlyBudgetUsd) return false;
    return true;
  }

  /** Record completed usage as USD. Free-model usage is always $0. */
  record(tier: RoutingTier, inputTokens: number, outputTokens: number): void {
    this.rollover();
    if (tier !== 'free') {
      this.usage.spent[tier] += this.cost(tier, inputTokens, outputTokens);
    }
    this.persist();
  }

  totalSpent(): number {
    return TIERS.filter(t => t !== 'free').reduce((sum, t) => sum + this.usage.spent[t], 0);
  }

  /** Per-plan model + budget overview for the UI/API. */
  allPlans(): PlanOverview[] {
    const models: Record<RoutingTier, string[]> = {
      free: [this.routing.free.model],
      fast: [this.routing.fast.model],
      reasoning: [this.routing.reasoning.model],
      frontend: [this.routing.frontend.model],
      difficult: [this.routing.difficult.model],
    };
    return (Object.keys(PLAN_PROFILES) as PlanTier[]).map(tier => ({
      tier,
      name: PLAN_PROFILES[tier].name,
      priceUsd: PLAN_PROFILES[tier].monthlyPriceUsd,
      budgetUsd: PLAN_PROFILES[tier].monthlyBudgetUsd,
      models,
      slotBudgets: PLAN_PROFILES[tier].slotBudgetUsd,
    }));
  }

  snapshot(): RouterSnapshot {
    this.rollover();
    const spent = this.totalSpent();
    const remaining = this.profile.monthlyBudgetUsd === Infinity
      ? Infinity
      : Math.max(0, this.profile.monthlyBudgetUsd - spent);
    return {
      plan: this.tier,
      planName: this.profile.name,
      monthlyPriceUsd: this.profile.monthlyPriceUsd,
      monthlyBudgetUsd: this.profile.monthlyBudgetUsd,
      spentUsd: spent,
      remainingUsd: remaining,
      hostedPlan: this.planAllowsHosted(),
      maxOutputTokens: this.profile.maxOutputTokens,
      enabled: this.routing.enabled,
      optimizations: {
        promptCaching: this.routing.cacheHitRatio > 0,
        cacheHitRatio: this.routing.cacheHitRatio,
        graphify: this.routing.graphify,
        caveman: this.routing.caveman,
      },
      tiers: {
        free: { ...this.routing.free },
        fast: { ...this.routing.fast },
        reasoning: { ...this.routing.reasoning },
        frontend: { ...this.routing.frontend },
        difficult: { ...this.routing.difficult },
      },
      slotBudgets: { ...this.profile.slotBudgetUsd },
      spentBySlot: { ...this.usage.spent },
      plans: this.allPlans(),
    };
  }

  // ── Persistence (spend counters survive restarts) ─────────────

  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private monthKey(d: Date): string {
    return d.toISOString().slice(0, 7);
  }

  private loadUsage(): RouterUsage {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) {
      return { date: this.dayKey(this.now()), month: this.monthKey(this.now()), spent: { ...EMPTY_SPENT } };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8')) as Partial<RouterUsage>;
      const spent = { ...EMPTY_SPENT };
      if (parsed.spent && typeof parsed.spent === 'object') {
        for (const key of TIERS) {
          spent[key] = Number((parsed.spent as any)[key]) || 0;
        }
      }
      return {
        date: typeof parsed.date === 'string' ? parsed.date : this.dayKey(this.now()),
        month: typeof parsed.month === 'string' ? parsed.month : this.monthKey(this.now()),
        spent,
      };
    } catch {
      return { date: this.dayKey(this.now()), month: this.monthKey(this.now()), spent: { ...EMPTY_SPENT } };
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.usage), 'utf-8');
    } catch {
      // Best-effort persistence; in-memory counters remain authoritative.
    }
  }

  private rollover(): void {
    const month = this.monthKey(this.now());
    if (this.usage.month !== month) {
      this.usage.month = month;
      this.usage.date = this.dayKey(this.now());
      this.usage.spent = { ...EMPTY_SPENT };
    } else if (this.usage.date !== this.dayKey(this.now())) {
      this.usage.date = this.dayKey(this.now());
    }
  }
}
