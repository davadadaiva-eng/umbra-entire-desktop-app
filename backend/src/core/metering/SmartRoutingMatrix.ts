/**
 * SmartRoutingMatrix — JIT multi-model routing with Prompt Caching (Sticky Routing)
 *
 * Umbra lineup (OpenRouter IDs — see pricing.ts, the single source of truth):
 *   FRONTEND       = 'google/gemini-2.5-flash'      // frontend + fast tools
 *   VISION         = 'google/gemini-2.5-pro'        // screenshots, computer/mobile
 *   REASONING      = 'moonshotai/kimi-k3'           // flagship reasoning (Advanced/Enterprise)
 *   REASONING_PRO  = 'moonshotai/kimi-k2-thinking'  // pro reasoning (K3 costs $5.85/session)
 *   BACKEND        = 'z-ai/glm-5-long'              // backend + large repos
 *   AGENTIC        = 'muse/muse-spark-1.3'          // agentic code
 *   AGENTIC_ALT    = 'qwen/qwen3-max'               // agentic-code alternative
 *   FRONTIER       = 'anthropic/claude-sonnet-5'    // difficult/rare, heavy architecture
 *   FREE           = 'meta-llama/llama-3.1-8b-instruct:free' // $0 safety ceiling
 *
 * Prompt caching: we keep the system prompt + OCR frame prefix IDENTICAL
 * across consecutive loops (sticky routing) so providers can hit cache_read
 * on repeating desktop frames. See buildStickySystemPrompt().
 */

import { MODELS as CATALOG, PLAN_ROUTES, type TaskKind } from './pricing';

export const MODELS = {
  FREE: CATALOG.free.id,
  FLASH: CATALOG.geminiFlash.id,
  VISION: CATALOG.geminiPro.id,
  REASONING: CATALOG.kimiK3.id,
  REASONING_PRO: CATALOG.kimiThinking.id,
  BACKEND: CATALOG.glmLong.id,
  AGENTIC: CATALOG.spark.id,
  AGENTIC_ALT: CATALOG.qwenMax.id,
  FRONTIER: CATALOG.claudeSonnet.id,
} as const;

export type TaskType = TaskKind;
export type Plan = 'pro' | 'advanced' | 'ultimate' | 'enterprise' | 'free' | 'byok';

export interface Pricing {
  input: number;        // $/1M input
  cacheRead: number;    // $/1M cache_read
  output: number;       // $/1M output
}

// Built from pricing.ts — never duplicate a rate here.
export const PRICING: Record<string, Pricing> = Object.fromEntries(
  Object.values(CATALOG).map(m => [m.id, { input: m.inputPerM, cacheRead: m.cacheReadPerM, output: m.outputPerM }]),
);

/** Pre-built sticky prefix — identical across loops to trigger cache hits */
export const STICKY_PREFIX = `You are Umbra OS — screen-aware desktop agent.
You see repeating desktop frames; reuse the cached prompt prefix verbatim.
Respond with JSON only when asked.`;

export function buildStickySystemPrompt(extra: string): string {
  // Keep structure identical: prefix + "\n\n" + extra — extra is the only
  // variable part; caching still hits on the prefix block.
  return `${STICKY_PREFIX}\n\n${extra}`;
}

export interface RouteDecision {
  model: string;
  reason: string;
  blocked: boolean; // true if tier blocks this class
}

export class SmartRoutingMatrix {
  /**
   * Tier + taskType → model.
   * When walletDepleted=true, everything collapses to FREE ($0).
   */
  route(plan: Plan, taskType: TaskType, opts: { walletDepleted?: boolean; preferAltVision?: boolean } = {}): RouteDecision {
    if (opts.walletDepleted) {
      return { model: MODELS.FREE, reason: 'wallet depleted → free fallback (safety ceiling)', blocked: false };
    }
    const p = plan === 'ultimate' ? 'advanced' : plan;
    if (p !== 'pro' && p !== 'advanced' && p !== 'enterprise') {
      return { model: MODELS.FREE, reason: 'free/byok → free fallback', blocked: false };
    }
    const entry = PLAN_ROUTES[p][taskType] ?? PLAN_ROUTES[p].routine;
    // Resolve the ModelKey → OpenRouter ID.
    const catalogEntry = (CATALOG as Record<string, { id: string }>)[entry.model as string];
    const modelId = catalogEntry ? catalogEntry.id : MODELS.FLASH;
    // Cheap-vision alternative for OCR loops.
    if (taskType === 'vision_ocr' && opts.preferAltVision) {
      return { model: MODELS.FLASH, reason: `${p.toUpperCase()} vision (alt) → Gemini Flash for cache discount`, blocked: false };
    }
    return { model: modelId, reason: entry.reason, blocked: entry.blocked };
  }

  /** Calculate cost from OpenRouter usage block (incl. cache_read). */
  calculateCost(model: string, usage: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }): number {
    const pricing = PRICING[model] || PRICING[MODELS.FREE];
    const cached = usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const uncachedPrompt = Math.max(0, prompt - cached);
    const cost = (uncachedPrompt / 1_000_000) * pricing.input
               + (cached / 1_000_000) * pricing.cacheRead
               + (completion / 1_000_000) * pricing.output;
    return Number(cost.toFixed(6));
  }

  /** Infer task type from planner/tool context (heuristic). */
  inferTaskType(action: string, description?: string): TaskType {
    const a = (action || '').toLowerCase();
    const d = (description || '').toLowerCase();
    const blob = `${a} ${d}`;
    if (blob.match(/ocr|vision|screenshot|capture|read_screen|snapshot|computer|mobile|phone|click|tap|swipe/)) return 'vision_ocr';
    if (blob.match(/agentic|autonomous|spark|multi_step|multistep|tool_loop/)) return 'agentic_code';
    if (blob.match(/backend|monorepo|large_repo|largerepo|codebase|refactor_arch/)) return 'backend_heavy';
    if (blob.match(/reasoning|plan|orchestrat|architecture|thought|debug/)) return 'reasoning';
    if (blob.match(/codemod|migrate|scaffold|implement_feature|refactor/)) return 'coding_heavy';
    if (blob.match(/script|snippet|frontend|component|style|css|button|type_text/)) return 'coding_fast';
    return 'routine';
  }
}
