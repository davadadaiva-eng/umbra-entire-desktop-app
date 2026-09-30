/**
 * pricing.ts — THE single source of truth for all money + model numbers.
 *
 * Everything that prices, budgets, or routes imports from here:
 *   - ModelRouter (PLAN_PROFILES, DEFAULT_ROUTING)
 *   - SmartRoutingMatrix (MODELS, PRICING, per-plan route tables)
 *   - VirtualWallet (getBudgets)
 *   - HetznerProvisioner (server types + monthly cost)
 *   - scripts/setup.ts (OPENROUTER_SLOTS)
 *   - MeteringService (token caps live next to TIERS below)
 *
 * Rules:
 *   - Wallet arithmetic is currency-agnostic units; € mirrors $ 1:1.
 *   - Rates are $/1M tokens, verified against OpenRouter (Sep 2026).
 *   - Entries flagged `verified: false` MUST be confirmed on
 *     https://openrouter.ai/models before relying on them in production —
 *     the router treats them normally, but margins are estimates.
 *   - Manual sync: when OpenRouter prices drift, update the numbers here
 *     and every consumer follows. Never duplicate a price elsewhere.
 */

import type { PlanTier, RoutingTier } from '../../types';

// ── Plans ─────────────────────────────────────────────────────────

export interface PlanProfile {
  name: string;
  monthlyPriceUsd: number;
  /** AI-model spend allowance (wallet units; € mirrors $). */
  monthlyBudgetUsd: number;
  /** Cloud VPS allowance (EUR). */
  cloudBudgetEur: number;
  telcoBudgetUsd: number;
  slotBudgetUsd: Record<RoutingTier, number>;
  maxOutputTokens: number;
  devices: number | 'unlimited';
  tokenCap: number;
}

export const PLAN_PROFILES: Record<PlanTier, PlanProfile> = {
  free: {
    name: 'Free',
    monthlyPriceUsd: 0,
    monthlyBudgetUsd: 0,
    cloudBudgetEur: 0,
    telcoBudgetUsd: 0,
    slotBudgetUsd: { free: 0, fast: 0, reasoning: 0, frontend: 0, difficult: 0 },
    maxOutputTokens: 800,
    devices: 1,
    tokenCap: 100_000,
  },
  byok: {
    name: 'Bring your own key',
    monthlyPriceUsd: 0,
    monthlyBudgetUsd: Infinity,
    cloudBudgetEur: 0,
    telcoBudgetUsd: 0,
    slotBudgetUsd: { free: Infinity, fast: Infinity, reasoning: Infinity, frontend: Infinity, difficult: Infinity },
    maxOutputTokens: 800,
    devices: 1,
    tokenCap: 1_000_000,
  },
  pro: {
    name: 'Pro',
    monthlyPriceUsd: 19.99,
    monthlyBudgetUsd: 5,
    cloudBudgetEur: 6.7,
    telcoBudgetUsd: 0,
    slotBudgetUsd: { free: 0, fast: 1, reasoning: 1, frontend: 1, difficult: 2 },
    maxOutputTokens: 800,
    devices: 1,
    tokenCap: 10_000_000,
  },
  ultimate: {
    name: 'Advanced',
    monthlyPriceUsd: 38,
    monthlyBudgetUsd: 10,
    cloudBudgetEur: 10,
    telcoBudgetUsd: 0,
    slotBudgetUsd: { free: 0, fast: 2, reasoning: 2, frontend: 2, difficult: 4 },
    maxOutputTokens: 1200,
    devices: 5,
    tokenCap: 50_000_000,
  },
  enterprise: {
    name: 'Enterprise',
    monthlyPriceUsd: 89.99,
    monthlyBudgetUsd: 30,
    cloudBudgetEur: 29.99,
    telcoBudgetUsd: 15,
    slotBudgetUsd: { free: 0, fast: 4, reasoning: 4, frontend: 4, difficult: 8 },
    maxOutputTokens: 2000,
    devices: 'unlimited',
    tokenCap: Infinity,
  },
};

/** 'advanced' is an accepted alias of 'ultimate' everywhere. */
export function normalizePlan(tier: string): PlanTier {
  if (tier === 'advanced') return 'ultimate';
  if (tier === 'free' || tier === 'byok' || tier === 'pro' || tier === 'ultimate' || tier === 'enterprise') return tier;
  throw new Error(`Unknown plan: ${tier}`);
}

// ── Models ────────────────────────────────────────────────────────

export interface ModelPrice {
  /** OpenRouter model ID (author/slug). */
  id: string;
  /** $/1M input tokens. */
  inputPerM: number;
  /** $/1M cache-read tokens. */
  cacheReadPerM: number;
  /** $/1M output tokens. */
  outputPerM: number;
  /** False = rate/ID estimated — confirm on openrouter.ai/models. */
  verified: boolean;
  blurb: string;
}

export const MODELS = {
  /** $0 fallback / spillover. */
  free: {
    id: 'meta-llama/llama-3.1-8b-instruct:free',
    inputPerM: 0, cacheReadPerM: 0, outputPerM: 0,
    verified: true, blurb: 'Free spillover',
  },
  /** Frontend + fast tools + computer/mobile (flash half). */
  geminiFlash: {
    id: 'google/gemini-2.5-flash',
    inputPerM: 0.3, cacheReadPerM: 0.03, outputPerM: 2.5,
    verified: true, blurb: 'Frontend, fast tools, mobile',
  },
  /** Computer/mobile vision + pro thinking fallback. */
  geminiPro: {
    id: 'google/gemini-2.5-pro',
    inputPerM: 1.25, cacheReadPerM: 0.125, outputPerM: 10.0,
    verified: true, blurb: 'Vision, computer use, pro thinking',
  },
  /** Reasoning flagship (Advanced/Enterprise). 1M context. */
  kimiK3: {
    id: 'moonshotai/kimi-k3',
    inputPerM: 2.6, cacheReadPerM: 0.29, outputPerM: 13.0,
    verified: true, blurb: 'Flagship reasoning, agentic coding',
  },
  /** Pro reasoning (K3 costs $5.85/session — too rich for the €5 budget). */
  kimiThinking: {
    id: 'moonshotai/kimi-k2-thinking',
    inputPerM: 0.6, cacheReadPerM: 0.06, outputPerM: 3.0,
    verified: false, blurb: 'Pro reasoning — confirm slug + rates',
  },
  /** Backend + large-repo workhorse (Pro). */
  glmLong: {
    id: 'z-ai/glm-5-long',
    inputPerM: 1.4, cacheReadPerM: 0.14, outputPerM: 4.4,
    verified: false, blurb: 'Backend, large repos — confirm slug + rates',
  },
  /** Agentic code (all paid plans). */
  spark: {
    id: 'muse/muse-spark-1.3',
    inputPerM: 1.25, cacheReadPerM: 0.125, outputPerM: 5.0,
    verified: false, blurb: 'Agentic code — input verified, output estimated',
  },
  /** Difficult/rare, heavy backend + architecture (Advanced/Enterprise). */
  claudeSonnet: {
    id: 'anthropic/claude-sonnet-5',
    inputPerM: 2.0, cacheReadPerM: 0.2, outputPerM: 10.0,
    verified: true, blurb: 'Frontier coding — intro pricing, standard $3/$15 after Aug 2026',
  },
  /** Agentic-code alternative (Advanced/Enterprise). */
  qwenMax: {
    id: 'qwen/qwen3-max',
    inputPerM: 0.4, cacheReadPerM: 0.04, outputPerM: 1.6,
    verified: false, blurb: 'Agentic-code alt — confirm slug + rates',
  },
} satisfies Record<string, ModelPrice>;

export type ModelKey = keyof typeof MODELS;

// ── Routing slots (5 legacy tiers → flagship defaults) ───────────
// Plan-specific downgrades (Pro blocks K3/Claude) live in the
// SmartRoutingMatrix route table, not here.

export interface SlotDefaults {
  provider: 'openai-compatible' | 'anthropic';
  modelKey: ModelKey;
  endpoint?: string;
}

export const SLOT_DEFAULTS: Record<RoutingTier, SlotDefaults> = {
  free: { provider: 'openai-compatible', modelKey: 'free', endpoint: 'https://openrouter.ai/api/v1' },
  fast: { provider: 'openai-compatible', modelKey: 'geminiFlash' },
  reasoning: { provider: 'openai-compatible', modelKey: 'kimiK3' },
  frontend: { provider: 'openai-compatible', modelKey: 'geminiFlash' },
  difficult: { provider: 'openai-compatible', modelKey: 'claudeSonnet' },
};

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';
export const CACHE_HIT_RATIO = 0.85;

// ── Per-plan task routing (SmartRoutingMatrix policy) ────────────
// Wallet-empty ALWAYS collapses to free. Pro blocks flagship
// reasoners (K3 $5.85/session would vaporize the €5 budget).

export type PlanId = 'pro' | 'advanced' | 'enterprise' | 'free' | 'byok';
export type TaskKind = 'vision_ocr' | 'reasoning' | 'coding_heavy' | 'coding_fast' | 'routine' | 'backend_heavy' | 'agentic_code';

export const PLAN_ROUTES: Record<Exclude<PlanId, 'free' | 'byok'>, Record<TaskKind, { model: ModelKey; blocked: boolean; reason: string }>> = {
  pro: {
    vision_ocr: { model: 'geminiPro', blocked: false, reason: 'PRO vision → Gemini Pro' },
    reasoning: { model: 'kimiThinking', blocked: true, reason: 'PRO reasoning → Kimi Thinking (K3 blocked: €5 budget)' },
    coding_heavy: { model: 'glmLong', blocked: true, reason: 'PRO heavy backend → GLM Long (Claude/K3 blocked)' },
    coding_fast: { model: 'geminiFlash', blocked: false, reason: 'PRO scripting → Gemini Flash' },
    routine: { model: 'geminiFlash', blocked: false, reason: 'PRO routine → Gemini Flash' },
    backend_heavy: { model: 'glmLong', blocked: false, reason: 'PRO large repos → GLM Long' },
    agentic_code: { model: 'spark', blocked: false, reason: 'PRO agentic code → Muse Spark 1.3' },
  },
  advanced: {
    vision_ocr: { model: 'geminiPro', blocked: false, reason: 'ADVANCED vision → Gemini Pro' },
    reasoning: { model: 'kimiK3', blocked: false, reason: 'ADVANCED planning → Kimi K3' },
    coding_heavy: { model: 'claudeSonnet', blocked: false, reason: 'ADVANCED heavy → Claude Sonnet 5' },
    coding_fast: { model: 'geminiFlash', blocked: false, reason: 'ADVANCED iterative → Gemini Flash' },
    routine: { model: 'geminiFlash', blocked: false, reason: 'ADVANCED routine → Gemini Flash' },
    backend_heavy: { model: 'glmLong', blocked: false, reason: 'ADVANCED large repos → GLM Long' },
    agentic_code: { model: 'spark', blocked: false, reason: 'ADVANCED agentic code → Muse Spark 1.3 (alt: Qwen Max)' },
  },
  enterprise: {
    vision_ocr: { model: 'geminiPro', blocked: false, reason: 'ENTERPRISE vision → Gemini Pro' },
    reasoning: { model: 'kimiK3', blocked: false, reason: 'ENTERPRISE planning → Kimi K3' },
    coding_heavy: { model: 'claudeSonnet', blocked: false, reason: 'ENTERPRISE heavy → Claude Sonnet 5' },
    coding_fast: { model: 'spark', blocked: false, reason: 'ENTERPRISE iterative → Muse Spark 1.3' },
    routine: { model: 'geminiFlash', blocked: false, reason: 'ENTERPRISE routine → Gemini Flash' },
    backend_heavy: { model: 'claudeSonnet', blocked: false, reason: 'ENTERPRISE large repos → Claude Sonnet 5' },
    agentic_code: { model: 'spark', blocked: false, reason: 'ENTERPRISE agentic code → Muse Spark 1.3 (alt: Qwen Max)' },
  },
};

// ── Cloud VPS (Hetzner, EUR) ──────────────────────────────────────

export interface CloudSpec {
  type: string;
  costEur: number;
  label: string;
}

export const CLOUD_SPECS: Record<string, CloudSpec> = {
  pro: { type: 'cx33', costEur: 6.7, label: '€6.70/mo' },
  advanced: { type: 'cx43', costEur: 10, label: '€10/mo' },
  ultimate: { type: 'cx43', costEur: 10, label: '€10/mo' },
  enterprise: { type: 'cpx42', costEur: 29.99, label: '€29.99/mo' },
  free: { type: 'cx22', costEur: 3.79, label: '€3.79/mo' },
};

/** Resolve a plan/user tier to its cloud spec (enterprise gets its own box). */
export function cloudSpecFor(tier: string): CloudSpec {
  const t = tier === 'advanced' ? 'advanced' : tier === 'pro' ? 'pro' : tier === 'ultimate' ? 'ultimate' : tier === 'enterprise' ? 'enterprise' : 'free';
  return CLOUD_SPECS[t] ?? CLOUD_SPECS.pro;
}

// ── Wallet ────────────────────────────────────────────────────────

export interface WalletBudgets {
  models: number;
  cloud: number;
  telco: number;
}

/** JIT safety ceilings, mirrored from PLAN_PROFILES (models + telco) and CLOUD_SPECS. */
export function walletBudgets(tier: string): WalletBudgets {
  switch (tier) {
    case 'pro': return { models: 5, cloud: 6.7, telco: 0 };
    case 'ultimate':
    case 'advanced': return { models: 10, cloud: 10, telco: 0 };
    case 'enterprise': return { models: 30, cloud: 29.99, telco: 15 };
    default: return { models: 0, cloud: 0, telco: 0 };
  }
}
