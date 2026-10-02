/**
 * pricing.test.ts — margin audit over the single source of truth.
 *
 * These tests pin the business contract, not the implementation:
 * every model verified on OpenRouter, wallet mirrors plan profiles,
 * slot partitions fit inside monthly ceilings, and a typical heavy
 * session (~200K input @85% cache + 8K output) fits its slot budget.
 * A price hike or slug typo breaks loudly here first.
 */
import {
  MODELS,
  PLAN_PROFILES,
  PLAN_ROUTES,
  TASK_TO_SLOT,
  costForModel,
  normalizeRoutePlan,
  planSlotModels,
  walletBudgets,
  type RoutePlan,
} from './pricing';

const INPUT = 200_000;
const CACHED = 170_000; // 85% sticky-cache hit rate
const OUTPUT = 8_000;

function sessionCost(modelId: string): number {
  return costForModel(modelId, INPUT, OUTPUT, CACHED);
}

describe('pricing audit', () => {
  it('every model is verified on OpenRouter with sane rates', () => {
    for (const m of Object.values(MODELS)) {
      expect(m.id).toMatch(/^[^/]+\/[^/]+$/);
      expect(m.verified).toBe(true);
      expect(m.inputPerM).toBeGreaterThanOrEqual(0);
      expect(m.cacheReadPerM).toBeGreaterThanOrEqual(0);
      expect(m.outputPerM).toBeGreaterThanOrEqual(0);
      expect(m.cacheReadPerM).toBeLessThanOrEqual(m.inputPerM);
    }
  });

  it('known slugs survived the Sep 2026 verification', () => {
    expect(MODELS.spark.id).toBe('meta/muse-spark-1.3');
    expect(MODELS.glm5.id).toBe('z-ai/glm-5');
    expect(MODELS.kimiThinking.outputPerM).toBe(2.5);
    expect(MODELS.qwenMax.inputPerM).toBe(0.78);
  });

  it('wallet budgets mirror the plan profiles', () => {
    for (const tier of ['pro', 'ultimate', 'advanced', 'enterprise'] as const) {
      const w = walletBudgets(tier);
      const profile = PLAN_PROFILES[tier === 'advanced' ? 'ultimate' : tier];
      expect(w.models).toBe(profile.monthlyBudgetUsd);
      expect(w.cloud).toBe(profile.cloudBudgetEur);
      expect(w.telco).toBe(profile.telcoBudgetUsd);
    }
  });

  it('slot partitions fit inside the monthly ceilings', () => {
    for (const tier of ['pro', 'ultimate', 'enterprise'] as const) {
      const slots = PLAN_PROFILES[tier].slotBudgetUsd;
      const sum = slots.fast + slots.reasoning + slots.frontend + slots.difficult;
      expect(sum).toBeLessThanOrEqual(PLAN_PROFILES[tier].monthlyBudgetUsd);
    }
    // Enterprise keeps headroom: 20 partitioned of 30 for burst/absorption.
    expect(PLAN_PROFILES.enterprise.monthlyBudgetUsd).toBe(30);
  });

  it('a typical heavy session fits its slot budget', () => {
    // Pro reasoning (Kimi Thinking) inside the $1 reasoning slot.
    expect(sessionCost(MODELS.kimiThinking.id)).toBeLessThan(0.1);
    // Advanced flagship reasoning (Kimi K3) inside the $2 reasoning slot.
    expect(sessionCost(MODELS.kimiK3.id)).toBeLessThan(0.5);
    // Enterprise frontier (Sonnet 5) inside the $8 difficult slot.
    expect(sessionCost(MODELS.claudeSonnet.id)).toBeLessThan(0.5);
    // Pro vision (Gemini Pro) inside the $1 fast slot.
    expect(sessionCost(MODELS.geminiPro.id)).toBeLessThan(0.25);
    // Pro backend (GLM 5) inside the $2 difficult slot.
    expect(sessionCost(MODELS.glm5.id)).toBeLessThan(0.1);
  });

  it('the flagship costs multiples of the pro substitute (justifies the block)', () => {
    const k3 = sessionCost(MODELS.kimiK3.id);
    const thinking = sessionCost(MODELS.kimiThinking.id);
    expect(k3 / thinking).toBeGreaterThan(3);
  });

  it('normalizeRoutePlan folds the ultimate/advanced alias', () => {
    expect(normalizeRoutePlan('ultimate')).toBe('advanced');
    expect(normalizeRoutePlan('advanced')).toBe('advanced');
    expect(normalizeRoutePlan('pro')).toBe('pro');
    expect(normalizeRoutePlan('enterprise')).toBe('enterprise');
    expect(normalizeRoutePlan('free')).toBeNull();
    expect(normalizeRoutePlan('byok')).toBeNull();
  });

  it('every task kind maps to a real budget slot', () => {
    for (const task of Object.keys(PLAN_ROUTES.pro)) {
      expect(TASK_TO_SLOT[task as keyof typeof TASK_TO_SLOT]).toMatch(/^(fast|reasoning|difficult)$/);
    }
  });

  it('plan slot models cover every paid plan with no empties', () => {
    for (const plan of ['pro', 'advanced', 'enterprise'] as RoutePlan[]) {
      const buckets = planSlotModels(plan);
      expect(buckets.free).toEqual([MODELS.free.id]);
      for (const slot of ['fast', 'reasoning', 'difficult'] as const) {
        expect(buckets[slot].length).toBeGreaterThan(0);
      }
    }
  });
});
