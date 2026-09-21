import { SmartRoutingMatrix, MODELS, buildStickySystemPrompt, PRICING } from './SmartRoutingMatrix';

describe('SmartRoutingMatrix', () => {
  const router = new SmartRoutingMatrix();

  describe('route()', () => {
    it('returns free fallback when wallet depleted', () => {
      const decision = router.route('pro', 'vision_ocr', { walletDepleted: true });
      expect(decision.model).toBe(MODELS.ROUTINE_FALLBACK);
      expect(decision.blocked).toBe(false);
    });

    it('pro routes vision to Luna (or M3 with preferAlt)', () => {
      const d1 = router.route('pro', 'vision_ocr');
      expect(d1.model).toBe(MODELS.VISION_PRIMARY);
      const d2 = router.route('pro', 'vision_ocr', { preferAltVision: true });
      expect(d2.model).toBe(MODELS.VISION_ALTERNATIVE);
    });

    it('pro blocks reasoning (downgrades to flash)', () => {
      const d = router.route('pro', 'reasoning');
      expect(d.model).toBe(MODELS.CODING_FAST);
      expect(d.blocked).toBe(true);
    });

    it('pro blocks coding_heavy (downgrades to flash)', () => {
      const d = router.route('pro', 'coding_heavy');
      expect(d.model).toBe(MODELS.CODING_FAST);
      expect(d.blocked).toBe(true);
    });

    it('pro allows coding_fast', () => {
      const d = router.route('pro', 'coding_fast');
      expect(d.model).toBe(MODELS.CODING_FAST);
      expect(d.blocked).toBe(false);
    });

    it('advanced routes reasoning to R1', () => {
      const d = router.route('advanced', 'reasoning');
      expect(d.model).toBe(MODELS.REASONING_CORE);
      expect(d.blocked).toBe(false);
    });

    it('advanced routes coding_heavy to v4-pro', () => {
      const d = router.route('advanced', 'coding_heavy');
      expect(d.model).toBe(MODELS.CODING_FRONTIER);
      expect(d.blocked).toBe(false);
    });

    it('free always routes to free fallback', () => {
      const d = router.route('free', 'reasoning');
      expect(d.model).toBe(MODELS.ROUTINE_FALLBACK);
    });

    it('ultimate maps to advanced routing', () => {
      const d = router.route('ultimate', 'reasoning');
      expect(d.model).toBe(MODELS.REASONING_CORE);
    });

    it('enterprise allows all models (reasoning, coding_heavy, vision)', () => {
      const d1 = router.route('enterprise', 'reasoning');
      expect(d1.model).toBe(MODELS.REASONING_CORE);
      expect(d1.blocked).toBe(false);
      const d2 = router.route('enterprise', 'coding_heavy');
      expect(d2.model).toBe(MODELS.CODING_FRONTIER);
      expect(d2.blocked).toBe(false);
      const d3 = router.route('enterprise', 'vision_ocr');
      expect(d3.model).toBe(MODELS.VISION_PRIMARY);
      expect(d3.blocked).toBe(false);
    });
  });

  describe('calculateCost()', () => {
    it('calculates cost with cache_read discount', () => {
      const cost = router.calculateCost(MODELS.VISION_PRIMARY, {
        prompt_tokens: 1000,
        completion_tokens: 500,
        cached_tokens: 800,
      });
      // uncached: 200 * $3/1M = $0.0006, cached: 800 * $0.3/1M = $0.00024, output: 500 * $12/1M = $0.006
      expect(cost).toBeCloseTo(0.00684, 5);
    });

    it('returns 0 for free model', () => {
      const cost = router.calculateCost(MODELS.ROUTINE_FALLBACK, {
        prompt_tokens: 10000,
        completion_tokens: 5000,
      });
      expect(cost).toBe(0);
    });
  });

  describe('inferTaskType()', () => {
    it('detects vision/ocr tasks', () => {
      expect(router.inferTaskType('screenshot')).toBe('vision_ocr');
      expect(router.inferTaskType('read_screen')).toBe('vision_ocr');
    });

    it('detects reasoning tasks', () => {
      expect(router.inferTaskType('plan_architecture')).toBe('reasoning');
    });

    it('detects coding_heavy', () => {
      expect(router.inferTaskType('refactor_frontend')).toBe('coding_heavy');
    });

    it('detects coding_fast', () => {
      expect(router.inferTaskType('click_button')).toBe('coding_fast');
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
      expect(p1.startsWith(MODELS.VISION_PRIMARY) || p1.startsWith('You are Umbra')).toBe(true);
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
