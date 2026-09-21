import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { MeteredLLMConnector } from './MeteredLLMConnector';
import { MeteringService } from './MeteringService';
import { UmbraConfig } from '../../types';

const dir = path.join(os.tmpdir(), `umbra-metered-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

const CANARY = { message: { content: 'pong' }, prompt_eval_count: 23, eval_count: 7, done_reason: 'stop' };

function makeConfig(endpoint: string): UmbraConfig {
  return {
    provider: 'ollama',
    models: { provider: 'ollama', reasoning: 'test-model', vision: 'test-vision', fast: 'test-fast' },
    ollama: { endpoint },
    hotkeys: { overlay: '', pause: '', togglePreview: '' },
    workspace: { maxSwarmDisplays: 1, displayWidth: 0, displayHeight: 0, displayFps: 0, cpuLimit: 0, gpuLimit: 0 },
    paths: { dataDir: dir, knowledgeDir: dir, recallDb: dir, vaultDir: dir, logsDir: dir },
    audio: { enabled: false, gestureCooldownMs: 0 },
    realDesktop: { chromePath: '', cdpPort: 0, windowWidth: 0, windowHeight: 0, enabled: false },
    repos: [],
    logging: { level: 'warn', prettyPrint: false },
    p2p: { enabled: false, webPort: 0, signalingPort: 0, stunServers: [], relayFps: 0 },
    plan: { tier: 'free', apiCreditPool: 0, imagesMonthly: 0, videoMonthly: 0 },
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

describe('MeteredLLMConnector', () => {
  let server: http.Server;
  let port: number;
  let requests: number;

  beforeEach(async () => {
    requests = 0;
    server = http.createServer((req, res) => {
      requests++;
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CANARY));
      });
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('completes, accounts tokens from usage, and reports success', async () => {
    const metering = new MeteringService({ dataDir: dir });
    const conn = new MeteredLLMConnector(makeConfig(`http://127.0.0.1:${port}`), metering);

    const res = await conn.complete([{ role: 'user', content: 'hi' }], 'fast');
    expect(res.content).toBe('pong');
    expect(metering.snapshot().tokensUsed).toBe(30);
    expect(metering.circuitStates()).toEqual([]);
    expect(requests).toBe(1);
  });

  it('opens the circuit after repeated failures and then fails fast', async () => {
    const metering = new MeteringService({ dataDir: dir, circuitThreshold: 2 });
    const conn = new MeteredLLMConnector(makeConfig('http://127.0.0.1:1'), metering);

    await expect(conn.complete([{ role: 'user', content: 'x' }])).rejects.toThrow();
    await expect(conn.complete([{ role: 'user', content: 'x' }])).rejects.toThrow();
    expect(metering.circuitStates()[0].state).toBe('open');

    // Third call is rejected by the breaker without touching the network.
    await expect(conn.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(/circuit breaker open/);
  });

  it('gates calls when the plan budget is exhausted', async () => {
    const metering = new MeteringService({ dataDir: dir, tier: 'free' });
    metering.recordTokens(100_000 - 50);
    const conn = new MeteredLLMConnector(makeConfig(`http://127.0.0.1:${port}`), metering);

    await expect(conn.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Plan limit reached/);
    expect(requests).toBe(0);
  });
});