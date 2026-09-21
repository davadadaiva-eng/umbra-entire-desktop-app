/**
 * demo.ts — run a live, self-contained demo of the model-routing / billing
 * engine without booting the full Umbra OS desktop stack.
 *
 *   npx ts-node scripts/demo.ts
 *
 * Prints:
 *   1. the plan ladder + per-slot budget split,
 *   2. the $5/$10 token math (with prompt caching + Caveman caps),
 *   3. real routed completions through an in-process mock server (showing
 *      which model each task type picks, plus free-model spillover).
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { ModelRouter, PLAN_PROFILES, DEFAULT_ROUTING } from '../src/core/metering/ModelRouter';
import { RoutedLLMConnector } from '../src/core/metering/RoutedLLMConnector';
import { MeteringService } from '../src/core/metering/MeteringService';
import { UmbraConfig } from '../src/types';

const dir = path.join(os.tmpdir(), `umbra-demo-${Date.now()}`);

const M = 1_000_000;

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : n.toFixed(2);
}

function section(title: string): void {
  console.log(`\n${'='.repeat(66)}\n${title}\n${'='.repeat(66)}`);
}

function demoConfig(endpoint: string): UmbraConfig {
  const t = (model: string) => ({ provider: 'ollama' as const, model, inputPerM: 0.14, cacheHitPerM: 0.0028, outputPerM: 0.28 });
  return {
    provider: 'ollama',
    models: { provider: 'ollama', reasoning: 'r', vision: 'v', fast: 'f' },
    ollama: { endpoint },
    hotkeys: { overlay: '', pause: '', togglePreview: '' },
    workspace: { maxSwarmDisplays: 1, displayWidth: 0, displayHeight: 0, displayFps: 0, cpuLimit: 0, gpuLimit: 0 },
    paths: { dataDir: dir, knowledgeDir: dir, recallDb: dir, vaultDir: dir, logsDir: dir },
    audio: { enabled: false, gestureCooldownMs: 0 },
    realDesktop: { chromePath: '', cdpPort: 0, windowWidth: 0, windowHeight: 0, enabled: false },
    repos: [],
    logging: { level: 'warn', prettyPrint: false },
    p2p: { enabled: false, webPort: 0, signalingPort: 0, stunServers: [], relayFps: 0 },
    plan: {
      tier: 'pro',
      apiCreditPool: 0,
      imagesMonthly: 0,
      videoMonthly: 0,
      routing: {
        enabled: true,
        cacheHitRatio: 0.85,
        graphify: true,
        caveman: true,
        free: t('free-model'),
        fast: t('fast-model'),
        reasoning: t('reasoning-model'),
        frontend: t('frontend-model'),
        difficult: t('difficult-model'),
      },
    },
    graphify: { enabled: false, maxContextTokens: 0, summaryTokens: 0, chunkTokens: 0 },
    compiler: { enabled: false, backend: 'none', outputDir: dir },
    mcp: { enabled: false, connectors: [] },
    shadow: { enabled: false, capture: 'gdi', fps: 0 },
    meeting: { enabled: false, stt: 'none', tts: 'none', loopbackEnabled: true, chunkSec: 12 },
    awareness: { enabled: true },
    telco: { enabled: false, provider: 'telnyx', fromNumber: '' },
    docker: { enabled: false, socketPath: '', defaultCpus: 0, defaultMemoryMb: 0 },
    billing: { enabled: false, provider: 'stripe', secretKey: '', webhookSecret: '', priceIds: { pro: '', ultimate: '', enterprise: '' }, publicUrl: '' },
    devices: { enabled: false, hubPort: 0, hubUrl: '', name: 'demo', role: 'desktop' },
    image: { enabled: false, provider: 'huggingface', model: '', apiKey: '' },
    voice: { enabled: false, sttProvider: 'none', sttEndpoint: '', sttApiKey: '', sttModel: 'whisper-1' },
    hermes: { enabled: true, bin: '', taskTimeoutMs: 300_000, autoDelegate: true },
  };
}

function blendedInput(perM: { cacheHitPerM: number; inputPerM: number }, hit: number): number {
  return hit * perM.cacheHitPerM + (1 - hit) * perM.inputPerM;
}

async function main(): Promise<void> {
  section('1. PLAN LADDER + BUDGET SPLIT');
  console.log('plan        price     model budget   cloud budget   telco   split (flash / r1 / muse / sonnet)');
  for (const tier of Object.keys(PLAN_PROFILES) as (keyof typeof PLAN_PROFILES)[]) {
    const p = PLAN_PROFILES[tier];
    const b = p.slotBudgetUsd;
    console.log(
      `${tier.padEnd(10)} $${String(p.monthlyPriceUsd).padEnd(8)} $${String(p.monthlyBudgetUsd).padEnd(13)} $${String(p.cloudBudgetUsd).padEnd(12)} $${String(p.telcoBudgetUsd).padEnd(6)} $${b.fast} / $${b.reasoning} / $${b.frontend} / $${b.difficult}`,
    );
  }

  section('2. TOKEN MATH ($5 Pro model budget, 85% prompt-cache hit)');
  console.log('slot           input $/1M   output $/1M   $ budget   ~input tokens');
  const hit = DEFAULT_ROUTING.cacheHitRatio;
  const slots = [
    ['DeepSeek Flash', DEFAULT_ROUTING.fast],
    ['DeepSeek-R1', DEFAULT_ROUTING.reasoning],
    ['Muse Spark 1.2', DEFAULT_ROUTING.frontend],
    ['Claude Sonnet 5', DEFAULT_ROUTING.difficult],
  ] as const;
  const profile = PLAN_PROFILES.pro;
  for (const [name, cfg] of slots) {
    const inPerM = blendedInput(cfg, hit);
    const budget = profile.slotBudgetUsd[cfg === DEFAULT_ROUTING.fast ? 'fast' : cfg === DEFAULT_ROUTING.reasoning ? 'reasoning' : cfg === DEFAULT_ROUTING.frontend ? 'frontend' : 'difficult'];
    const tokens = budget / (inPerM / M);
    console.log(
      `${name.padEnd(15)} $${inPerM.toFixed(4).padEnd(11)} $${cfg.outputPerM.toFixed(2).padEnd(10)} $${String(budget).padEnd(9)} ~${fmt(tokens)}`,
    );
  }

  section('3. LIVE ROUTED CALLS (mock server)');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: `answered by ${parsed.model}` }, prompt_eval_count: 120, eval_count: 40, done_reason: 'stop' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const config = demoConfig(`http://127.0.0.1:${port}`);
  const metering = new MeteringService({ dataDir: dir });
  const router = new ModelRouter({ config });
  const conn = new RoutedLLMConnector(config, metering, router);

  const calls: Array<['reasoning' | 'vision' | 'fast', 'general' | 'frontend' | 'difficult', string]> = [
    ['fast', 'general', 'daily quick task'],
    ['reasoning', 'general', 'daily agentic task'],
    ['fast', 'frontend', 'design the landing page'],
    ['reasoning', 'difficult', 'hard architecture decision'],
  ];
  for (const [role, task, desc] of calls) {
    const res = await conn.complete([{ role: 'user', content: desc }], role, { task });
    console.log(`  ${desc.padEnd(28)} → ${res.content}`);
  }

  section('4. FREE-MODEL SPILLOVER (budget exhausted)');
  router.record('fast', 200_000_000, 0); // blow the $1 flash slot budget
  const spill = await conn.complete([{ role: 'user', content: 'another quick task' }], 'fast');
  console.log(`  fast slot budget exhausted → ${spill.content}`);
  console.log(`\n  total spent this month: $${router.snapshot().spentUsd.toFixed(4)} of $5`);

  await new Promise<void>(resolve => server.close(() => resolve()));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
