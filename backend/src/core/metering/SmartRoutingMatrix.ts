/**
 * SmartRoutingMatrix — JIT multi-model routing with Prompt Caching (Sticky Routing)
 *
 * Spec Model IDs (OpenRouter):
 *   VISION_PRIMARY    = 'openai/gpt-5.6-luna'   // flagship vision, ultra-low cache_read rates
 *   VISION_ALTERNATIVE= 'minimax/m3'           // Chinese vision, UI localization
 *   REASONING_CORE    = 'deepseek/deepseek-r1'        // complex orchestration
 *   CODING_FRONTIER   = 'deepseek/v4-pro'       // heavy codebase editing
 *   CODING_FAST       = 'deepseek/v4-flash'     // instant script generation
 *   ROUTINE_LIGHT     = 'qwen/qwen-2.5-flash'         // hyper-budget background
 *   ROUTINE_FALLBACK  = 'openrouter/free'       // $0 strict ceiling
 *
 * Prompt caching: we keep the system prompt + OCR frame prefix IDENTICAL
 * across consecutive loops (sticky routing) so OpenRouter can hit cache_read
 * on repeating desktop frames. See buildStickySystemPrompt().
 */

export const MODELS = {
  VISION_PRIMARY: 'openai/gpt-5.6-luna',
  VISION_ALTERNATIVE: 'minimax/m3',
  REASONING_CORE: 'deepseek/deepseek-r1',
  CODING_FRONTIER: 'deepseek/v4-pro',
  CODING_FAST: 'deepseek/v4-flash',
  ROUTINE_LIGHT: 'qwen/qwen-2.5-flash',
  ROUTINE_FALLBACK: 'openrouter/free',
} as const;

export type TaskType = 'vision_ocr' | 'reasoning' | 'coding_heavy' | 'coding_fast' | 'routine' ;
export type Plan = 'pro' | 'advanced' | 'ultimate' | 'enterprise' | 'free' | 'byok';

export interface Pricing {
  input: number;        // $/1M input
  cacheRead: number;    // $/1M cache_read (ultra-low for Luna)
  output: number;       // $/1M output
}

// Spec pricing placeholder (€ mirrors $ for wallet): real rates should be
// synced from https://openrouter.ai/models — these defaults keep wallet
// arithmetic deterministic for tests.
export const PRICING: Record<string, Pricing> = {
  [MODELS.VISION_PRIMARY]:     { input: 3.0,  cacheRead: 0.3,  output: 12.0 },
  [MODELS.VISION_ALTERNATIVE]: { input: 1.0,  cacheRead: 0.2, output: 4.0  },
  [MODELS.REASONING_CORE]:     { input: 0.55, cacheRead: 0.14, output: 2.19 },
  [MODELS.CODING_FRONTIER]:    { input: 0.7,  cacheRead: 0.15, output: 2.8  },
  [MODELS.CODING_FAST]:        { input: 0.14, cacheRead: 0.03, output: 0.28 },
  [MODELS.ROUTINE_LIGHT]:      { input: 0.05, cacheRead: 0.01, output: 0.2  },
  [MODELS.ROUTINE_FALLBACK]:   { input: 0.0,  cacheRead: 0.0,  output: 0.0  },
};

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
   * When walletDepleted=true, everything collapses to ROUTINE_FALLBACK ($0).
   */
  route(plan: Plan, taskType: TaskType, opts: { walletDepleted?: boolean; preferAltVision?: boolean } = {}): RouteDecision {
    if (opts.walletDepleted) {
      return { model: MODELS.ROUTINE_FALLBACK, reason: 'wallet depleted → free fallback (safety ceiling)', blocked: false };
    }
    const p = plan === 'ultimate' ? 'advanced' : plan;

    if (p === 'enterprise') {
      switch (taskType) {
        case 'vision_ocr':
          return { model: opts.preferAltVision ? MODELS.VISION_ALTERNATIVE : MODELS.VISION_PRIMARY, reason: 'ENTERPRISE vision → Luna/M3 cached frames', blocked: false };
        case 'coding_heavy':
          return { model: MODELS.CODING_FRONTIER, reason: 'ENTERPRISE heavy → v4-pro', blocked: false };
        case 'coding_fast':
          return { model: MODELS.CODING_FAST, reason: 'ENTERPRISE iterative → v4-flash', blocked: false };
        case 'reasoning':
          return { model: MODELS.REASONING_CORE, reason: 'ENTERPRISE planning → R1 thought block', blocked: false };
        case 'routine':
        default:
          return { model: MODELS.ROUTINE_LIGHT, reason: 'ENTERPRISE routine → qwen-flash', blocked: false };
      }
    }

    if (p === 'pro') {
      // PRO wallet €5 — block R1 + v4-pro completely
      switch (taskType) {
        case 'vision_ocr':
          return { model: opts.preferAltVision ? MODELS.VISION_ALTERNATIVE : MODELS.VISION_PRIMARY, reason: 'PRO vision → Luna/M3 for cache discount', blocked: false };
        case 'coding_fast':
          return { model: MODELS.CODING_FAST, reason: 'PRO scripting → v4-flash rock bottom', blocked: false };
        case 'coding_heavy':
          return { model: MODELS.CODING_FAST, reason: 'PRO heavy coding downgraded to flash (R1/Pro blocked)', blocked: true };
        case 'reasoning':
          return { model: MODELS.CODING_FAST, reason: 'PRO reasoning downgraded to flash (R1 blocked)', blocked: true };
        case 'routine':
        default:
          return { model: MODELS.ROUTINE_LIGHT, reason: 'PRO routine → qwen-flash / free ($0 base)', blocked: false };
      }
    }

    if ((p as string) === 'advanced') {
      switch (taskType) {
        case 'reasoning':
          return { model: MODELS.REASONING_CORE, reason: 'ADVANCED planning → R1 thought block', blocked: false };
        case 'coding_heavy':
          return { model: MODELS.CODING_FRONTIER, reason: 'ADVANCED heavy → v4-pro', blocked: false };
        case 'coding_fast':
          return { model: MODELS.CODING_FAST, reason: 'ADVANCED iterative → v4-flash', blocked: false };
        case 'vision_ocr':
          return { model: opts.preferAltVision ? MODELS.VISION_ALTERNATIVE : MODELS.VISION_PRIMARY, reason: 'ADVANCED vision → Luna/M3 cached frames', blocked: false };
        case 'routine':
        default:
          return { model: MODELS.ROUTINE_LIGHT, reason: 'ADVANCED routine → qwen-flash', blocked: false };
      }
    }

    // free/byok
    return { model: MODELS.ROUTINE_FALLBACK, reason: 'free/byok → free fallback', blocked: false };
  }

  /** Calculate cost from OpenRouter usage block (incl. cache_read). */
  calculateCost(model: string, usage: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }): number {
    const pricing = PRICING[model] || PRICING[MODELS.ROUTINE_FALLBACK];
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
    if (blob.match(/ocr|vision|screenshot|capture|read_screen|snapshot/)) return 'vision_ocr';
    if (blob.match(/reasoning|plan|orchestrat|architecture|thought/)) return 'reasoning';
    if (blob.match(/heavy|multi.*file|codebase|refactor|frontend|coding_frontier/)) return 'coding_heavy';
    if (blob.match(/script|automation|flash|type|click|scroll|press/)) return 'coding_fast';
    return 'routine';
  }
}
