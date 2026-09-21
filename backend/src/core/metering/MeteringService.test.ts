import { MeteringService, TIER_LIMITS } from './MeteringService';
import * as os from 'os';
import * as path from 'path';

const dir = path.join(os.tmpdir(), `umbra-meter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

describe('MeteringService', () => {
  it('defaults to the free tier', () => {
    const m = new MeteringService({ dataDir: dir });
    expect(m.currentTier).toBe('free');
    expect(TIER_LIMITS.free.monthlyTokens).toBeLessThan(TIER_LIMITS.pro.monthlyTokens);
  });

  it('gates work by token budget', () => {
    const m = new MeteringService({ dataDir: dir });
    expect(m.canAfford(1000)).toBe(true);
    m.recordTokens(TIER_LIMITS.free.monthlyTokens - 500);
    expect(m.canAfford(1000)).toBe(false);
    expect(m.canAfford(400)).toBe(true);
  });

  it('caps concurrent sessions', () => {
    const m = new MeteringService({ dataDir: dir });
    expect(m.openSession()).toBe(true);
    expect(m.openSession()).toBe(false);
    m.closeSession();
    expect(m.openSession()).toBe(true);
  });

  it('reports a snapshot with remaining tokens', () => {
    const m = new MeteringService({ dataDir: dir });
    m.recordTokens(10_000);
    const snap = m.snapshot();
    expect(snap.remainingTokens).toBe(TIER_LIMITS.free.monthlyTokens - 10_000);
    expect(snap.tokensUsed).toBe(10_000);
  });

  describe('circuit breakers', () => {
    it('opens after threshold failures and blocks traffic', () => {
      const m = new MeteringService({ dataDir: dir, circuitThreshold: 3 });
      for (let i = 0; i < 3; i++) m.reportFailure('ollama');
      expect(m.allow('ollama')).toBe(false);
      expect(m.circuitStates()[0].state).toBe('open');
    });

    it('closes again after success', () => {
      const m = new MeteringService({ dataDir: dir, circuitThreshold: 2 });
      m.reportFailure('api');
      m.reportFailure('api');
      expect(m.allow('api')).toBe(false);
      m.reportSuccess('api');
      expect(m.allow('api')).toBe(true);
    });

    it('allows unaffected services', () => {
      const m = new MeteringService({ dataDir: dir });
      m.reportFailure('flaky');
      expect(m.allow('healthy')).toBe(true);
    });
  });
});
