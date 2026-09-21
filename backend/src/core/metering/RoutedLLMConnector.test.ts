import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { RoutedLLMConnector } from './RoutedLLMConnector';
import { ModelRouter } from './ModelRouter';
import { MeteringService } from './MeteringService';
import { TenantLedger } from '../billing/TenantLedger';
import { RoutingConfig, UmbraConfig } from '../../types';

const dir = path.join(os.tmpdir(), `umbra-routed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

function makeConfig(endpoint: string, routingOverrides: Partial<RoutingConfig> = {}): UmbraConfig {
  const tier = (model: string) => ({ provider: 'ollama' as const, model, inputPerM: 0.1, cacheHitPerM: 0.01, outputPerM: 0.1 });
  const routing: RoutingConfig = {
    enabled: true,
    cacheHitRatio: 0.85,
    graphify: true,
    caveman: true,
    free: tier('free-model'),
    fast: tier('fast-model'),
    reasoning: tier('reasoning-model'),
    frontend: tier('frontend-model'),
    difficult: tier('difficult-model'),
    ...routingOverrides,
  };
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
    plan: { tier: 'pro', apiCreditPool: 0, imagesMonthly: 0, videoMonthly: 0, routing },
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

describe('RoutedLLMConnector', () => {
  let server: http.Server;
  let port: number;
  let lastBody: any;

  beforeEach(async () => {
    lastBody = undefined;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        lastBody = parsed;
        if (parsed.model.startsWith('fail')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'boom' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: `pong:${parsed.model}` }, prompt_eval_count: 20, eval_count: 10, done_reason: 'stop' }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('routes fast roles to the fast slot and reasoning to the reasoning slot', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(endpoint);
    const metering = new MeteringService({ dataDir: dir });
    const conn = new RoutedLLMConnector(config, metering, new ModelRouter({ config }));

    expect((await conn.complete([{ role: 'user', content: 'hi' }], 'fast')).content).toBe('pong:fast-model');
    expect((await conn.complete([{ role: 'user', content: 'think' }], 'reasoning')).content).toBe('pong:reasoning-model');
  });

  it('honors frontend and difficult task hints', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(endpoint);
    const metering = new MeteringService({ dataDir: dir });
    const conn = new RoutedLLMConnector(config, metering, new ModelRouter({ config }));

    expect((await conn.complete([{ role: 'user', content: 'design' }], 'fast', { task: 'frontend' })).content).toBe('pong:frontend-model');
    expect((await conn.complete([{ role: 'user', content: 'hard' }], 'reasoning', { task: 'difficult' })).content).toBe('pong:difficult-model');
  });

  it('caps output tokens at the plan max (800) and records usage', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(endpoint);
    const metering = new MeteringService({ dataDir: dir });
    const router = new ModelRouter({ config });
    const conn = new RoutedLLMConnector(config, metering, router);
    await conn.complete([{ role: 'user', content: 'hi' }], 'fast', { maxTokens: 9999 });
    expect(lastBody.options.num_predict).toBe(800);
    expect(router.snapshot().spentBySlot.fast).toBeGreaterThan(0);
  });

  it('spills over to free models when the hosted slot fails', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(endpoint, { reasoning: { provider: 'ollama', model: 'fail-model', inputPerM: 0.1, cacheHitPerM: 0.01, outputPerM: 0.1 } });
    const metering = new MeteringService({ dataDir: dir });
    const conn = new RoutedLLMConnector(config, metering, new ModelRouter({ config }));
    const res = await conn.complete([{ role: 'user', content: 'think' }], 'reasoning');
    expect(res.content).toBe('pong:free-model');
  });

  it('spills over to free models when the budget is exhausted', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(endpoint);
    const metering = new MeteringService({ dataDir: dir });
    const router = new ModelRouter({ config });
    router.record('fast', 200_000_000, 0); // exceeds the $3 day slot budget
    const conn = new RoutedLLMConnector(config, metering, router);
    const res = await conn.complete([{ role: 'user', content: 'hi' }], 'fast');
    expect(res.content).toBe('pong:free-model');
  });

  it('meters per tenant: an exhausted tenant spills to free while others keep the paid slot', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(endpoint);
    const metering = new MeteringService({ dataDir: dir });
    const defaultRouter = new ModelRouter({ config });
    const ledger = new TenantLedger({ config, dataDir: dir, defaultRouter });
    ledger.register({ id: 'alice', tier: 'pro' });
    ledger.register({ id: 'bob', tier: 'pro' });
    // Blow through alice's $1 fast slot on her own ledger only.
    ledger.routerFor('alice').record('fast', 200_000_000, 0);
    const conn = new RoutedLLMConnector(config, metering, defaultRouter, ledger);

    const aliceRes = await TenantLedger.run('alice', () => conn.complete([{ role: 'user', content: 'hi' }], 'fast'));
    expect(aliceRes.content).toBe('pong:free-model'); // alice: budget gone → free models
    expect(ledger.routerFor('bob').snapshot().spentBySlot.fast).toBe(0); // alice's spend never leaked into bob's ledger

    const bobRes = await TenantLedger.run('bob', () => conn.complete([{ role: 'user', content: 'hi' }], 'fast'));
    expect(bobRes.content).toBe('pong:fast-model'); // bob: full budget intact

    const nodeRes = await conn.complete([{ role: 'user', content: 'hi' }], 'fast');
    expect(nodeRes.content).toBe('pong:fast-model'); // outside any tenant: node default router
  });

  it('locks the free plan to free models even with routing enabled', async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    const config = { ...makeConfig(endpoint), plan: { ...makeConfig(endpoint).plan, tier: 'free' as const } };
    const metering = new MeteringService({ dataDir: dir });
    const conn = new RoutedLLMConnector(config, metering, new ModelRouter({ config }));
    const res = await conn.complete([{ role: 'user', content: 'hi' }], 'reasoning');
    expect(res.content).toBe('pong:free-model');
  });
});
