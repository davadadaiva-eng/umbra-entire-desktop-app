import { ModelRouter, PLAN_PROFILES } from './ModelRouter';
import { UmbraConfig } from '../../types';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const dir = path.join(os.tmpdir(), `umbra-router-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

function makeConfig(overrides: Partial<UmbraConfig['plan']> = {}): UmbraConfig {
  return {
    provider: 'ollama',
    models: { provider: 'ollama', reasoning: 'r', vision: 'v', fast: 'f' },
    hotkeys: { overlay: '', pause: '', togglePreview: '' },
    workspace: { maxSwarmDisplays: 1, displayWidth: 0, displayHeight: 0, displayFps: 0, cpuLimit: 0, gpuLimit: 0 },
    paths: { dataDir: dir, knowledgeDir: dir, recallDb: dir, vaultDir: dir, logsDir: dir },
    audio: { enabled: false, gestureCooldownMs: 0 },
    realDesktop: { chromePath: '', cdpPort: 0, windowWidth: 0, windowHeight: 0, enabled: false },
    repos: [],
    logging: { level: 'warn', prettyPrint: false },
    p2p: { enabled: false, webPort: 0, signalingPort: 0, stunServers: [], relayFps: 0 },
    plan: { tier: 'pro', apiCreditPool: 0, imagesMonthly: 0, videoMonthly: 0, ...overrides },
    graphify: { enabled: false, maxContextTokens: 0, summaryTokens: 0, chunkTokens: 0 },
    compiler: { enabled: false, backend: 'none', outputDir: dir },
    mcp: { enabled: false, connectors: [] },
    shadow: { enabled: false, capture: 'gdi', fps: 0 },
    meeting: { enabled: false, stt: 'none', tts: 'none', loopbackEnabled: true, chunkSec: 12 },
    awareness: { enabled: true },
    telco: { enabled: false, provider: 'telnyx', fromNumber: '' },
    docker: { enabled: false, socketPath: '', defaultCpus: 0, defaultMemoryMb: 0 },
    billing: { enabled: false, provider: 'stripe', secretKey: '', webhookSecret: '', priceIds: { pro: '', ultimate: '', enterprise: '' }, publicUrl: '' },
    image: { enabled: false, provider: 'huggingface', model: '', apiKey: '' },
    hermes: { enabled: true, bin: '', taskTimeoutMs: 300_000, autoDelegate: true },
    devices: { enabled: true, hubPort: 8788, hubUrl: '', name: 'test', role: 'desktop' },
    voice: { enabled: false, sttProvider: 'none', sttEndpoint: '', sttApiKey: '', sttModel: 'whisper-1' },
  };
}

describe('ModelRouter', () => {
  it('routes by role, with task hints overriding to frontend/difficult', () => {
    const router = new ModelRouter({ config: makeConfig() });
    expect(router.routeFor('reasoning')).toBe('reasoning');
    expect(router.routeFor('fast')).toBe('fast');
    expect(router.routeFor('vision')).toBe('fast');
    expect(router.routeFor('fast', 'frontend')).toBe('frontend');
    expect(router.routeFor('reasoning', 'difficult')).toBe('difficult');
  });

  it('locks the free plan to free models regardless of role', () => {
    const router = new ModelRouter({ config: makeConfig({ tier: 'free' }) });
    expect(router.planAllowsHosted()).toBe(false);
    expect(router.resolveTier('reasoning')).toBe('free');
    expect(router.resolveTier('fast', 'frontend')).toBe('free');
  });

  it('splits Pro €5 as Sonnet $2 + three $1 slots, Ultimate doubles it, Enterprise $30', () => {
    expect(PLAN_PROFILES.pro.monthlyPriceUsd).toBe(19.99);
    expect(PLAN_PROFILES.pro.monthlyBudgetUsd).toBe(5);
    expect(PLAN_PROFILES.pro.cloudBudgetEur).toBe(6.7);
    expect(PLAN_PROFILES.pro.slotBudgetUsd).toEqual({ free: 0, fast: 1, reasoning: 1, frontend: 1, difficult: 2 });

    expect(PLAN_PROFILES.ultimate.monthlyPriceUsd).toBe(38);
    expect(PLAN_PROFILES.ultimate.monthlyBudgetUsd).toBe(10);
    expect(PLAN_PROFILES.ultimate.cloudBudgetEur).toBe(10);
    expect(PLAN_PROFILES.ultimate.slotBudgetUsd).toEqual({ free: 0, fast: 2, reasoning: 2, frontend: 2, difficult: 4 });

    expect(PLAN_PROFILES.enterprise.monthlyPriceUsd).toBe(89.99);
    expect(PLAN_PROFILES.enterprise.monthlyBudgetUsd).toBe(30);
    expect(PLAN_PROFILES.enterprise.cloudBudgetEur).toBe(29.99);
    expect(PLAN_PROFILES.enterprise.telcoBudgetUsd).toBe(15);
    expect(PLAN_PROFILES.enterprise.slotBudgetUsd).toEqual({ free: 0, fast: 4, reasoning: 4, frontend: 4, difficult: 8 });
  });

  it('exposes model slots and per-plan model overview', () => {
    const snap = new ModelRouter({ config: makeConfig() }).snapshot();
    expect(Object.keys(snap.tiers).sort()).toEqual(['difficult', 'fast', 'free', 'frontend', 'reasoning']);
    expect(snap.tiers.fast.model).toContain('gemini-2.5-flash');
    expect(snap.tiers.reasoning.model).toContain('kimi-k3');
    expect(snap.tiers.frontend.model).toContain('gemini-2.5-flash');
    expect(snap.tiers.difficult.model).toContain('sonnet');

    const pro = snap.plans.find(p => p.tier === 'pro')!;
    expect(pro.models.fast).toEqual(['google/gemini-2.5-flash']);
    expect(pro.models.reasoning).toEqual(['moonshotai/kimi-k3']);
    expect(pro.models.difficult).toEqual(['anthropic/claude-sonnet-5']);
  });

  it('uses a cloud OpenRouter free model as the spillover tier', () => {
    const snap = new ModelRouter({ config: makeConfig() }).snapshot();
    expect(snap.tiers.free.provider).toBe('openai-compatible');
    expect(snap.tiers.free.endpoint).toContain('openrouter.ai');
    expect(snap.tiers.free.model).toContain(':free');
  });

  it('reports the optimization stack (caching, graphify, caveman) as active', () => {
    const snap = new ModelRouter({ config: makeConfig() }).snapshot();
    expect(snap.optimizations.promptCaching).toBe(true);
    expect(snap.optimizations.graphify).toBe(true);
    expect(snap.optimizations.caveman).toBe(true);
    expect(snap.optimizations.cacheHitRatio).toBe(0.85);
  });

  it('applies the prompt-cache discount when estimating cost', () => {
    const router = new ModelRouter({ config: makeConfig() });
    // fast (Gemini Flash): 85% cache-hit → 0.85*0.03 + 0.15*0.30 = 0.0705 per 1M input tokens.
    expect(router.cost('fast', 1_000_000, 0)).toBeCloseTo(0.0705, 4);
    expect(router.cost('free', 1_000_000, 1_000_000)).toBe(0);
  });

  it('charges spend against the fast (Gemini Flash) $1 slot budget', () => {
    const router = new ModelRouter({ config: makeConfig({ tier: 'pro' }) });
    router.record('fast', 50_000_000, 0); // ~$3.53 exceeds the $1 slot
    expect(router.snapshot().spentBySlot.fast).toBeGreaterThan(1);
    expect(router.canAffordTier('fast', 1, 0)).toBe(false);
    expect(router.canAffordTier('free', 999_999, 999_999)).toBe(true);
  });

  it('gives the difficult (Claude) slot its own $2 budget', () => {
    const router = new ModelRouter({ config: makeConfig({ tier: 'pro' }) });
    router.record('difficult', 5_000_000, 0); // ~$2.35 exceeds the $2 slot
    expect(router.canAffordTier('difficult', 1_000_000, 0)).toBe(false);
    expect(router.canAffordTier('difficult', 100_000, 0)).toBe(false);
  });

  it('tracks total spend and remaining against the monthly budget', () => {
    const router = new ModelRouter({ config: makeConfig({ tier: 'pro' }) });
    router.record('fast', 1_000_000, 0);
    router.record('frontend', 1_000_000, 0);
    const snap = router.snapshot();
    expect(snap.spentUsd).toBeGreaterThan(0);
    expect(snap.remainingUsd).toBeCloseTo(5 - snap.spentUsd, 6);
    expect(snap.spentUsd).toBeLessThan(5);
  });

  it('never charges free-model traffic', () => {
    const router = new ModelRouter({ config: makeConfig({ tier: 'pro' }) });
    router.record('free', 10_000_000, 10_000_000);
    expect(router.snapshot().spentUsd).toBe(0);
  });

  it('persists spend counters and resets on month rollover', () => {
    const persistPath = path.join(dir, 'usage.json');
    let now = new Date('2026-08-14T12:00:00Z');
    const router = new ModelRouter({ config: makeConfig(), persistPath, now: () => now });
    router.record('fast', 1_000_000, 0);
    expect(fs.existsSync(persistPath)).toBe(true);

    now = new Date('2026-09-01T00:00:00Z');
    const reloaded = new ModelRouter({ config: makeConfig(), persistPath, now: () => now });
    expect(reloaded.snapshot().spentUsd).toBe(0);
  });
});
