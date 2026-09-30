import { SmartRoutingMatrix, MODELS, buildStickySystemPrompt, PRICING } from './SmartRoutingMatrix';

describe('SmartRoutingMatrix', () => {
  const router = new SmartRoutingMatrix();

  describe('route()', () => {
    it('returns free fallback when wallet depleted', () => {
      const decision = router.route('pro', 'vision_ocr', { walletDepleted: true });
      expect(decision.model).toBe(MODELS.FREE);
      expect(decision.blocked).toBe(false);
    });

    it('pro routes vision to Gemini Pro (or Flash with preferAlt)', () => {
      const d1 = router.route('pro', 'vision_ocr');
      expect(d1.model).toBe(MODELS.VISION);
      const d2 = router.route('pro', 'vision_ocr', { preferAltVision: true });
      expect(d2.model).toBe(MODELS.FLASH);
    });

    it('pro blocks flagship reasoning (downgrades to Kimi Thinking)', () => {
      const d = router.route('pro', 'reasoning');
      expect(d.model).toBe(MODELS.REASONING_PRO);
      expect(d.blocked).toBe(true);
    });

    it('pro routes heavy backend to GLM Long', () => {
      const d = router.route('pro', 'coding_heavy');
      expect(d.model).toBe(MODELS.BACKEND);
      expect(d.blocked).toBe(true);
    });

    it('pro allows coding_fast on Flash', () => {
      const d = router.route('pro', 'coding_fast');
      expect(d.model).toBe(MODELS.FLASH);
      expect(d.blocked).toBe(false);
    });

    it('pro routes agentic code to Muse Spark', () => {
      const d = router.route('pro', 'agentic_code');
      expect(d.model).toBe(MODELS.AGENTIC);
      expect(d.blocked).toBe(false);
    });

    it('advanced routes reasoning to Kimi K3', () => {
      const d = router.route('advanced', 'reasoning');
      expect(d.model).toBe(MODELS.REASONING);
      expect(d.blocked).toBe(false);
    });

    it('advanced routes coding_heavy to Claude Sonnet', () => {
      const d = router.route('advanced', 'coding_heavy');
      expect(d.model).toBe(MODELS.FRONTIER);
      expect(d.blocked).toBe(false);
    });

    it('free always routes to free fallback', () => {
      const d = router.route('free', 'reasoning');
      expect(d.model).toBe(MODELS.FREE);
    });

    it('ultimate maps to advanced routing', () => {
      const d = router.route('ultimate', 'reasoning');
      expect(d.model).toBe(MODELS.REASONING);
    });

    it('enterprise allows all models (reasoning, coding_heavy, vision)', () => {
      const d1 = router.route('enterprise', 'reasoning');
      expect(d1.model).toBe(MODELS.REASONING);
      expect(d1.blocked).toBe(false);
      const d2 = router.route('enterprise', 'coding_heavy');
      expect(d2.model).toBe(MODELS.FRONTIER);
      expect(d2.blocked).toBe(false);
      const d3 = router.route('enterprise', 'vision_ocr');
      expect(d3.model).toBe(MODELS.VISION);
      expect(d3.blocked).toBe(false);
    });
  });

  describe('calculateCost()', () => {
    it('calculates cost with cache_read discount', () => {
      const cost = router.calculateCost(MODELS.VISION, {
        prompt_tokens: 1000,
        completion_tokens: 500,
        cached_tokens: 800,
      });
      // uncached: 200 * $1.25/1M = $0.00025, cached: 800 * $0.125/1M = $0.0001, output: 500 * $10/1M = $0.005
      expect(cost).toBeCloseTo(0.00535, 5);
    });

    it('returns 0 for free model', () => {
      const cost = router.calculateCost(MODELS.FREE, {
        prompt_tokens: 10000,
        completion_tokens: 5000,
      });
      expect(cost).toBe(0);
    });
  });

  describe('inferTaskType()', () => {
    it('detects vision/ocr/computer-use tasks', () => {
      expect(router.inferTaskType('screenshot')).toBe('vision_ocr');
      expect(router.inferTaskType('read_screen')).toBe('vision_ocr');
      expect(router.inferTaskType('click_button')).toBe('vision_ocr');
    });

    it('detects reasoning tasks', () => {
      expect(router.inferTaskType('plan_architecture')).toBe('reasoning');
    });

    it('detects backend_heavy tasks', () => {
      expect(router.inferTaskType('refactor_monorepo')).toBe('backend_heavy');
    });

    it('detects agentic_code tasks', () => {
      expect(router.inferTaskType('agentic_fix_loop')).toBe('agentic_code');
    });

    it('detects coding_fast', () => {
      expect(router.inferTaskType('type_text')).toBe('coding_fast');
    });

    it('defaults to routine', () => {
      expect(router.inferTaskType('unknown_action')).toBe('routine');
    });
  });

  describe('buildStickySystemPrompt()', () => {
    it('keeps prefix identical for caching', () => {
      const p1 = buildStickySystemPrompt('extra A');
      const p2 = buildStickySystemPrompt('extra B');
      // The prefix part is identical
      expect(p1.startsWith('You are Umbra')).toBe(true);
      // They differ only in the extra
      expect(p1).not.toBe(p2);
      expect(p1.split('\n\n')[0]).toBe(p2.split('\n\n')[0]);
    });
  });

  describe('PRICING', () => {
    it('has pricing for all models', () => {
      for (const model of Object.values(MODELS)) {
        expect(PRICING[model]).toBeDefined();
        expect(PRICING[model].input).toBeGreaterThanOrEqual(0);
        expect(PRICING[model].output).toBeGreaterThanOrEqual(0);
        expect(PRICING[model].cacheRead).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
