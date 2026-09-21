import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImageGenerator } from './ImageGenerator';
import { UmbraConfig } from '../../types';
import { HttpBridge } from '../agent/HttpBridge';

jest.mock('../agent/HttpBridge');

const dir = path.join(os.tmpdir(), `umbra-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makeConfig(image: Partial<UmbraConfig['image']> = {}): UmbraConfig {
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
    image: { enabled: true, provider: 'huggingface', model: 'black-forest-labs/FLUX.1-schnell', apiKey: 'hf-test', ...image },
    hermes: { enabled: true, bin: '', taskTimeoutMs: 300_000, autoDelegate: true },
    devices: { enabled: true, hubPort: 8788, hubUrl: '', name: 'test', role: 'desktop' },
    voice: { enabled: false, sttProvider: 'none', sttEndpoint: '', sttApiKey: '', sttModel: 'whisper-1' },
  };
}

describe('ImageGenerator', () => {
  const mockPost = HttpBridge.post as jest.MockedFunction<typeof HttpBridge.post>;
  const mockGet = HttpBridge.get as jest.MockedFunction<typeof HttpBridge.get>;

  afterEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
  });

  it('generates an image through the Hugging Face (Flux Schnell) API', async () => {
    let receivedPrompt = '';
    mockPost.mockImplementation(async (url: string, body: any) => {
      receivedPrompt = body.inputs;
      return { status: 200, data: null, text: PNG.toString('base64') };
    });

    const gen = new ImageGenerator(makeConfig({ endpoint: 'http://fake-hf' }));
    const result = await gen.generate('a neon fox');
    expect(receivedPrompt).toBe('a neon fox');
    expect(result.provider).toBe('huggingface');
    expect(fs.existsSync(result.imagePath)).toBe(true);
  });

  it('polls a Replicate prediction until it succeeds and downloads the output', async () => {
    let polls = 0;
    mockPost.mockImplementation(async () => {
      return { status: 200, data: { id: 'p1', status: 'processing', urls: { get: '' } }, text: '{"id":"p1","status":"processing"}' };
    });
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/predictions/p1')) {
        polls++;
        if (polls >= 2) {
          return { status: 200, data: { id: 'p1', status: 'succeeded', output: ['http://fake/img.png'] }, text: '{"status":"succeeded","output":["http://fake/img.png"]}' };
        }
        return { status: 200, data: { id: 'p1', status: 'processing' }, text: '{"status":"processing"}' };
      }
      return { status: 200, data: PNG, text: PNG.toString('base64') };
    });

    const gen = new ImageGenerator(makeConfig({
      provider: 'replicate',
      model: 'flux-schnell',
      endpoint: 'http://fake-replicate',
    }));
    const result = await gen.generate('a neon fox');
    expect(result.provider).toBe('replicate');
    expect(fs.existsSync(result.imagePath)).toBe(true);
  });

  it('rejects when disabled or missing a prompt', async () => {
    const disabled = new ImageGenerator(makeConfig({ enabled: false }));
    await expect(disabled.generate('x')).rejects.toThrow(/disabled/);
    const enabled = new ImageGenerator(makeConfig());
    await expect(enabled.generate('')).rejects.toThrow(/prompt is required/);
  });
});
