import * as fs from 'fs';
import * as path from 'path';
import { UmbraConfig, ModelProvider, McpConnectorConfig, McpOauthClientConfig } from '../types';
import { getLogger } from '../core/Logger';
import { MCP_CATALOG, McpCatalogEntry } from '../core/mcp/McpCatalog';
import { DEFAULT_ROUTING } from '../core/metering/ModelRouter';

const DEFAULT_CONFIG: UmbraConfig = {
  provider: 'ollama',
  models: {
    provider: 'ollama',
    reasoning: 'qwen2.5:14b',
    vision: 'qwen2.5-vl:7b',
    fast: 'qwen2.5:7b',
  },
  hotkeys: {
    overlay: 'Cmd+K',
    pause: 'Ctrl+Shift+Space',
    togglePreview: 'Ctrl+Shift+P',
  },
  workspace: {
    maxSwarmDisplays: 4,
    displayWidth: 1920,
    displayHeight: 1080,
    displayFps: 60,
    cpuLimit: 80,
    gpuLimit: 80,
  },
  paths: {
    dataDir: '',
    knowledgeDir: '',
    recallDb: '',
    vaultDir: '',
    logsDir: '',
  },
  audio: {
    enabled: true,
    gestureCooldownMs: 2000,
  },
  realDesktop: {
    chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    cdpPort: 9224,
    windowWidth: 1280,
    windowHeight: 800,
    enabled: true,
  },
  repos: [],
  github: {
    enabled: false,
    repositories: [],
    pollIntervalMs: 60000,
    tokenService: 'github',
    consentRequired: true,
    commentResults: true,
  },
  logging: {
    level: 'info',
    prettyPrint: true,
  },
  p2p: {
    enabled: true,
    webPort: 9443,
    signalingPort: 9444,
    stunServers: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ],
    turnServers: [],
    relayFps: 10,
    meshEnabled: true,
  },
  devices: {
    enabled: true,
    hubPort: 8788,
    hubUrl: '',
    name: 'Umbra Desktop',
    role: 'desktop',
  },
  plan: {
    tier: 'free',
    apiCreditPool: 0,
    imagesMonthly: 0,
    videoMonthly: 0,
    routing: { ...DEFAULT_ROUTING },
  },
  graphify: {
    enabled: true,
    maxContextTokens: 12000,
    summaryTokens: 300,
    chunkTokens: 400,
  },
  compiler: {
    enabled: true,
    backend: 'node',
    outputDir: '',
  },
  mcp: {
    enabled: true,
    connectors: [],
    oauthClients: {},
  },
  shadow: {
    enabled: true,
    capture: 'gdi',
    fps: 15,
  },
  meeting: {
    enabled: false,
    stt: 'none',
    tts: 'none',
    loopbackEnabled: true,
    chunkSec: 12,
    ordersEnabled: true,
    screenShare: true,
    audioCable: 'none',
    routeMic: false,
    nativeApp: 'auto',
  },
  awareness: {
    enabled: true,
    watch: true,
    watchIntervalMs: 1000,
    followCursor: true,
  },
  telco: {
    enabled: false,
    provider: 'telnyx',
    fromNumber: '',
    messagingProfileId: '',
  },
  smartthings: {
    enabled: !!process.env['UMBRA_SMARTTHINGS_TOKEN'],
    token: process.env['UMBRA_SMARTTHINGS_TOKEN'] || '',
    baseUrl: process.env['UMBRA_SMARTTHINGS_URL'] || 'https://api.smartthings.com',
  },
  docker: {
    enabled: false,
    socketPath: '',
    defaultCpus: 2,
    defaultMemoryMb: 2048,
  },
  billing: {
    enabled: false,
    provider: 'stripe',
    secretKey: process.env['UMBRA_STRIPE_SECRET_KEY'] || '',
    webhookSecret: process.env['UMBRA_STRIPE_WEBHOOK_SECRET'] || '',
    priceIds: {
      pro: process.env['UMBRA_STRIPE_PRICE_PRO'] || '',
      ultimate: process.env['UMBRA_STRIPE_PRICE_ULTIMATE'] || '',
      enterprise: process.env['UMBRA_STRIPE_PRICE_ENTERPRISE'] || '',
    },
    publicUrl: process.env['UMBRA_PUBLIC_URL'] || '',
  },
  image: {
    enabled: false,
    provider: 'huggingface',
    model: 'black-forest-labs/FLUX.1-schnell',
    apiKey: '',
  },
  voice: {
    enabled: true,
    pushToTalk: '',
    sttProvider: 'none',
    sttEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
    sttApiKey: '',
    sttModel: 'whisper-1',
    vibevoiceVoice: 'Carter',
    vibevoiceLanguage: 'en',
    vibevoiceModel: 'microsoft/VibeVoice-Realtime-0.5B',
    vibevoiceDevice: 'auto',
    voiceboxUrl: 'http://127.0.0.1:17493',
    voiceboxProfile: '',
    voiceboxEngine: 'qwen',
    asrProvider: 'none',
    vibevoiceAsrUrl: 'http://127.0.0.1:17500',
    vibevoiceAsrModel: 'microsoft/VibeVoice-ASR',
    vibevoiceAsrContext: '',
    whisperAsrUrl: 'http://127.0.0.1:17501',
    whisperAsrModel: 'base',
    fasterWhisperUrl: 'http://127.0.0.1:17510',
    fasterWhisperLanguage: 'it',
    piperUrl: 'http://127.0.0.1:17520',
    piperVoice: 'it_IT-riccardo-medium',
    piperLanguage: 'it',
  },
  hermes: {
    enabled: true,
    bin: '',
    taskTimeoutMs: 300_000,
    autoDelegate: true,
  },
  cloud: {
    enabled: false,
    hetznerApiToken: '',
    sshKeyName: 'umbra-cloud',
  },
};

export class ConfigManager {
  private config: UmbraConfig;
  private configPath: string;

  constructor(dataDir?: string) {
    const baseDir = dataDir || path.join(process.env.USERPROFILE || '~', '.umbra');
    this.config = { ...DEFAULT_CONFIG };
    this.config.paths.dataDir = baseDir;
    this.config.paths.knowledgeDir = path.join(baseDir, 'knowledge');
    this.config.paths.recallDb = path.join(baseDir, 'recall.db');
    this.config.paths.vaultDir = path.join(baseDir, 'vault');
    this.config.paths.logsDir = path.join(baseDir, 'logs');
    this.config.compiler.outputDir = path.join(baseDir, 'compiled');
    this.configPath = path.join(baseDir, 'config.json');
  }

  async initialize(): Promise<void> {
    this.ensureDirectories();
    await this.loadConfig();
  }

  private ensureDirectories(): void {
    for (const dir of [
      this.config.paths.dataDir,
      this.config.paths.knowledgeDir,
      this.config.paths.vaultDir,
      this.config.paths.logsDir,
    ]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  async loadConfig(): Promise<UmbraConfig> {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        this.config = this.mergeConfig(DEFAULT_CONFIG, parsed);
      } else {
        await this.saveConfig();
      }
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'Config file invalid — using defaults (file NOT overwritten)');
    }
    return this.config;
  }

  async saveConfig(): Promise<void> {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  async updateProvider(provider: ModelProvider, models: Partial<UmbraConfig['models']>): Promise<void> {
    this.config.provider = provider;
    this.config.models.provider = provider;
    if (models.reasoning) this.config.models.reasoning = models.reasoning;
    if (models.vision) this.config.models.vision = models.vision;
    if (models.fast) this.config.models.fast = models.fast;
    await this.saveConfig();
  }

  async updateProviderCredentials(provider: ModelProvider, creds: { endpoint?: string; apiKey?: string }): Promise<void> {
    const key = provider === 'openai-compatible' ? 'openaiCompatible' : provider;
    if (key === 'openaiCompatible') {
      this.config.openaiCompatible = {
        ...this.config.openaiCompatible,
        ...creds,
        endpoint: creds.endpoint || this.config.openaiCompatible?.endpoint || '',
      };
    } else {
      (this.config as any)[key] = { ...(this.config as any)[key], ...creds };
    }
    await this.saveConfig();
  }

  async updateHotkeys(hotkeys: Partial<UmbraConfig['hotkeys']>): Promise<void> {
    Object.assign(this.config.hotkeys, hotkeys);
    await this.saveConfig();
  }

  /** Persist telco (Telnyx) settings — sender number + messaging profile.
   *  The API token itself lives in the CredentialVault (service 'telnyx'). */
  async updateTelco(patch: { enabled?: boolean; fromNumber?: string; messagingProfileId?: string }): Promise<void> {
    if (patch.enabled !== undefined) this.config.telco.enabled = patch.enabled;
    if (patch.fromNumber !== undefined) this.config.telco.fromNumber = patch.fromNumber;
    if (patch.messagingProfileId !== undefined) this.config.telco.messagingProfileId = patch.messagingProfileId;
    await this.saveConfig();
  }

  /** Persist voice settings — the push-to-talk hotkey combo + master switch. */
  async updateVoice(patch: { enabled?: boolean; pushToTalk?: string }): Promise<void> {
    if (patch.enabled !== undefined) this.config.voice.enabled = patch.enabled;
    if (patch.pushToTalk !== undefined) this.config.voice.pushToTalk = patch.pushToTalk;
    await this.saveConfig();
  }

  async updateVoiceFull(patch: Partial<UmbraConfig['voice']>): Promise<void> {
    Object.assign(this.config.voice, patch);
    await this.saveConfig();
  }

  /** Persist Stripe billing settings (keys, price ids, public URL). Secrets stay in config.json. */
  async updateBilling(patch: {
    enabled?: boolean;
    secretKey?: string;
    webhookSecret?: string;
    priceIds?: Partial<Record<string, string>>;
    publicUrl?: string;
  }): Promise<void> {
    if (patch.enabled !== undefined) this.config.billing.enabled = patch.enabled;
    if (patch.secretKey !== undefined) this.config.billing.secretKey = patch.secretKey;
    if (patch.webhookSecret !== undefined) this.config.billing.webhookSecret = patch.webhookSecret;
    if (patch.publicUrl !== undefined) this.config.billing.publicUrl = patch.publicUrl;
    if (patch.priceIds) Object.assign(this.config.billing.priceIds, patch.priceIds);
    await this.saveConfig();
  }

  /**
   * Reactivate every catalog connector into config (enabled: false) so the UI
   * can list all of them. Pre-existing entries keep their enabled/baseUrl.
   */
  async syncConnectorCatalog(): Promise<void> {
    let changed = false;
    for (const entry of MCP_CATALOG) {
      const existing = this.config.mcp.connectors.find(c => c.id === entry.id);
      if (!existing) {
        this.config.mcp.connectors.push(this.fromCatalog(entry));
        changed = true;
      }
    }
    if (changed) await this.saveConfig();
  }

  /** Persist (or update) a connector in config, keeping its catalog defaults. */
  async upsertMcpConnector(id: string, patch: Partial<McpConnectorConfig>): Promise<McpConnectorConfig> {
    const entry = MCP_CATALOG.find(c => c.id === id);
    const base = entry ? this.fromCatalog(entry) : undefined;
    let connector = this.config.mcp.connectors.find(c => c.id === id);
    if (!connector) {
      connector = { ...(base ?? { id, name: id, category: 'Custom', baseUrl: '', authType: 'none', enabled: false }) };
      this.config.mcp.connectors.push(connector);
    }
    Object.assign(connector, patch);
    await this.saveConfig();
    return connector;
  }

  /** Persist (or update) an OAuth client credential for a connector. */
  async upsertMcpOauthClient(key: string, patch: Partial<McpOauthClientConfig>): Promise<McpOauthClientConfig> {
    const existing = this.config.mcp.oauthClients?.[key] ?? { clientId: '' };
    const next = { ...existing, ...patch };
    this.config.mcp.oauthClients = { ...this.config.mcp.oauthClients, [key]: next };
    await this.saveConfig();
    return next;
  }

  getMcpOauthClient(key: string): McpOauthClientConfig | undefined {
    return this.config.mcp.oauthClients?.[key];
  }

  private fromCatalog(entry: McpCatalogEntry): McpConnectorConfig {
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      baseUrl: entry.baseUrl,
      authType: entry.authType,
      apiKeyHeader: entry.apiKeyHeader,
      credentialKey: entry.credentialKey,
      tool: entry.tool,
      enabled: false,
    };
  }

  get raw(): UmbraConfig {
    return this.config;
  }

  private mergeConfig(base: UmbraConfig, override: Partial<UmbraConfig>): UmbraConfig {
    const merged = { ...base };
    for (const key of Object.keys(override) as (keyof UmbraConfig)[]) {
      if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])) {
        (merged as any)[key] = { ...(base[key] as any), ...(override[key] as any) };
      } else if (override[key] !== undefined) {
        (merged as any)[key] = override[key];
      }
    }
    return merged;
  }
}
