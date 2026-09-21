import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { TenantLedger } from './TenantLedger';
import { ModelRouter } from '../metering/ModelRouter';
import { UmbraConfig } from '../../types';

const baseDir = path.join(os.tmpdir(), `umbra-tenants-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
let instance = 0;
const dir = () => path.join(baseDir, `t${instance++}`);

function makeConfig(tier: 'pro' | 'ultimate' | 'free' = 'pro'): UmbraConfig {
  return {
    provider: 'ollama',
    models: { provider: 'ollama', reasoning: 'r', vision: 'v', fast: 'f' },
    hotkeys: { overlay: '', pause: '', togglePreview: '' },
    workspace: { maxSwarmDisplays: 1, displayWidth: 0, displayHeight: 0, displayFps: 0, cpuLimit: 0, gpuLimit: 0 },
    paths: { dataDir: baseDir, knowledgeDir: baseDir, recallDb: baseDir, vaultDir: baseDir, logsDir: baseDir },
    audio: { enabled: false, gestureCooldownMs: 0 },
    realDesktop: { chromePath: '', cdpPort: 0, windowWidth: 0, windowHeight: 0, enabled: false },
    repos: [],
    logging: { level: 'warn', prettyPrint: false },
    p2p: { enabled: false, webPort: 0, signalingPort: 0, stunServers: [], relayFps: 0 },
    plan: { tier, apiCreditPool: 0, imagesMonthly: 0, videoMonthly: 0 },
    graphify: { enabled: false, maxContextTokens: 0, summaryTokens: 0, chunkTokens: 0 },
    compiler: { enabled: false, backend: 'none', outputDir: baseDir },
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

function makeLedger(opts: { tier?: 'pro' | 'ultimate' | 'free'; now?: () => Date; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? dir();
  const config = makeConfig(opts.tier);
  const configFor = (t: 'pro' | 'ultimate' | 'free') => ({
    ...config,
    plan: { ...config.plan, tier: t },
  });
  const now = opts.now ?? (() => new Date());
  const defaultRouter = new ModelRouter({ config: configFor('pro'), persistPath: path.join(dataDir, 'routing-usage.json'), now });
  const ledger = new TenantLedger({ config, dataDir, defaultRouter, now });
  return { ledger, defaultRouter, config, now, dataDir };
}

describe('TenantLedger', () => {
  it('keeps each tenant on its own router: spend on A never touches B or the node', () => {
    const { ledger, defaultRouter } = makeLedger();
    ledger.register({ id: 'alice', tier: 'pro' });
    ledger.register({ id: 'bob', tier: 'pro' });

    const alice = ledger.routerFor('alice');
    const bob = ledger.routerFor('bob');
    alice.record('fast', 100_000_000, 0); // ~2.3M tokens → several $ of spend
    expect(alice.snapshot().spentUsd).toBeGreaterThan(0);
    expect(bob.snapshot().spentUsd).toBe(0);
    expect(defaultRouter.snapshot().spentUsd).toBe(0);
  });

  it('spills only the exhausted tenant to free models while others keep their budget', () => {
    const { ledger } = makeLedger();
    ledger.register({ id: 'alice', tier: 'pro' });
    ledger.register({ id: 'bob', tier: 'pro' });
    const alice = ledger.routerFor('alice');
    const bob = ledger.routerFor('bob');
    // Blow through Alice's $1 fast slot (~50M input tokens ≈ $1.17).
    alice.record('fast', 50_000_000, 0);
    expect(alice.canAffordTier('fast', 1, 0)).toBe(false);
    expect(alice.canAffordTier('free', 1_000_000, 1_000_000)).toBe(true);
    expect(bob.canAffordTier('fast', 1_000_000, 0)).toBe(true);
  });

  it('binds the current tenant to the async chain via TenantLedger.run', async () => {
    const { ledger } = makeLedger();
    ledger.register({ id: 'carol', tier: 'pro' });
    let inChain: string | undefined;
    await TenantLedger.run('carol', async () => {
      await new Promise(r => setTimeout(r, 5)); // crosses an await boundary
      inChain = TenantLedger.current();
      expect(ledger.currentTenant()).toBe('carol'); // resolved against registered tenants
    });
    expect(inChain).toBe('carol');
    expect(TenantLedger.current()).toBeUndefined(); // outer scope unaffected
  });

  it('unregistered/disabled tenants fall back to the node default router', () => {
    const { ledger, defaultRouter } = makeLedger();
    ledger.register({ id: 'dave', tier: 'pro' });
    ledger.disable('dave');
    expect(ledger.routerFor('dave')).toBe(defaultRouter);
    expect(ledger.routerFor('nobody')).toBe(defaultRouter);
    expect(ledger.currentTenant()).toBeUndefined();
  });

  it('activate applies the plan tier + correct $ budget and device cap', () => {
    const { ledger } = makeLedger();
    ledger.register({ id: 'erin', tier: 'pro' });
    const pro = ledger.status('erin');
    expect(pro.usage!.monthlyBudgetUsd).toBe(5);
    expect(pro.deviceLimit).toBe(1);
    expect(pro.deviceLimitLabel).toBe(1);

    ledger.activate('erin', 'ultimate');
    const ultimate = ledger.status('erin');
    expect(ultimate.usage!.monthlyBudgetUsd).toBe(10);
    expect(ultimate.deviceLimit).toBe(5);
    expect(ultimate.deviceLimitLabel).toBe(5);

    ledger.activate('erin', 'enterprise');
    const enterprise = ledger.status('erin');
    expect(enterprise.usage!.monthlyBudgetUsd).toBe(20);
    expect(enterprise.deviceLimit).toBe(Infinity);
    expect(enterprise.deviceLimitLabel).toBe('unlimited');
  });

  it('persists the registry across instances and reloads it', () => {
    const shared = dir();
    const first = makeLedger({ dataDir: shared });
    first.ledger.register({ id: 'frank', name: 'Frank', tier: 'ultimate' });
    first.ledger.routerFor('frank').record('fast', 1_000_000, 0);

    const second = makeLedger({ dataDir: shared });
    const status = second.ledger.status('frank');
    expect(status.name).toBe('Frank');
    expect(status.tier).toBe('ultimate');
    // Spend counters survive too (per-tenant ledger file).
    expect(status.usage!.spentUsd).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(shared, 'tenants.json'))).toBe(true);
  });

  it('rolls tenant spend over at the month boundary', () => {
    let current = new Date('2026-01-15T12:00:00Z');
    const { ledger } = makeLedger({ now: () => current });
    ledger.register({ id: 'gina', tier: 'pro' });
    const gina = ledger.routerFor('gina');
    gina.record('fast', 10_000_000, 0);
    expect(gina.snapshot().spentUsd).toBeGreaterThan(0);

    current = new Date('2026-02-01T00:00:00Z');
    expect(gina.snapshot().spentUsd).toBe(0);
  });

  it('statuses() lists every tenant with usage + limits', () => {
    const { ledger } = makeLedger();
    ledger.register({ id: 'hank', tier: 'free' });
    ledger.register({ id: 'iris', tier: 'ultimate' });
    const all = ledger.statuses();
    expect(all.map(s => s.id).sort()).toEqual(['hank', 'iris']);
    expect(all[0].deviceLimit).toBe(1);
    expect(all[1].deviceLimit).toBe(5);
  });
});