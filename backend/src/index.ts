import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from './config/ConfigManager';
import { KnowledgeGraph } from './knowledge/KnowledgeGraph';
import { RecallToKnowledgeBridge } from './knowledge/RecallToKnowledgeBridge';
import { BrowserUseBridge } from './core/browseruse/BrowserUseBridge';
import { DeepUnderstandingEngine } from './knowledge/DeepUnderstandingEngine';
import { eventBus } from './core/EventBus';
import { initializeLogger, getLogger } from './core/Logger';
import { LLMConnector } from './core/agent/LLMConnector';
import { HttpBridge } from './core/agent/HttpBridge';
import { TaskPlanner } from './core/agent/TaskPlanner';
import { AgentRuntime } from './core/agent/AgentRuntime';
import { TaskStore } from './core/agent/TaskStore';
import { HermesAgentBridge } from './core/agent/HermesAgent';
import { ChromeExtensionBridge } from './core/browser/ChromeExtensionBridge';
import { WorkspaceFiles } from './core/agent/WorkspaceFiles';
import { ReposManager } from './core/agent/ReposManager';
import { InjectionGuard } from './core/agent/InjectionGuard';
import { ConsentGate } from './core/agent/ConsentGate';
import { ProactiveAgent } from './core/agent/ProactiveAgent';
import { IssueWatcher } from './core/agent/IssueWatcher';
import { VirtualDisplayManager } from './core/workspace/VirtualDisplayManager';
import { InputGuard } from './core/workspace/InputGuard';
import { SwarmManager } from './core/workspace/SwarmManager';
import { AgentDesktop } from './core/workspace/AgentDesktop';
import { SelfHealingGuard } from './core/selfheal/SelfHealingGuard';
import { VectorMemory } from './core/memory/VectorMemory';
import { ActivityWatcher } from './core/recall/ActivityWatcher';
import { MacroSynthesizer } from './core/recall/MacroSynthesizer';
import { AuditVault } from './core/vault/AuditVault';
import { NoiseCancellationEngine } from './core/audio/NoiseCancellationEngine';
import { PrivacyGuard } from './core/privacy/PrivacyGuard';
import { ScreenReader } from './core/vision/ScreenReader';
import { JournalGenerator } from './knowledge/journal/JournalGenerator';
import { TopicIndexer } from './knowledge/journal/TopicIndexer';
import { Desktop2Environment } from './core/desktop2/Desktop2Environment';
import { RealDesktop2 } from './core/desktop2/RealDesktop2';
import { PreviewStreamer } from './mobile/PreviewStreamer';
import { OpenMontageBridge } from './core/video/OpenMontageBridge';
import { VideoProducer } from './core/video/VideoProducer';
import { ImageGenerator } from './core/image/ImageGenerator';
import { SpeechToText } from './core/voice/SpeechToText';
import { ScreenAwareness } from './core/awareness/ScreenAwareness';
import { MeetingCompanion } from './core/meeting/MeetingCompanion';
import {
  detectMeetingProvider,
  meetingShareScript,
  meetingStopShareScript,
  meetingMuteScript,
  meetingRaiseHandScript,
  meetingChatScript,
  ShareTarget,
} from './core/meeting/MeetingScreenShare';
import {
  detectNativeMeetingApp,
  nativeShortcut,
  nativeProcessName,
  NativeMeetingAction,
} from './core/meeting/MeetingNativeControls';
import { focusWindow, sendHotkey, getWindowRect } from './native/win32/InputNative';
import { WindowsTts } from './core/audio/WindowsTts';
import { VibeVoiceTts } from './core/voice/VibeVoiceTts';
import { VoiceboxClient } from './core/voice/VoiceboxClient';
import { VibeVoiceAsr } from './core/voice/VibeVoiceAsr';
import { WhisperAsr } from './core/voice/WhisperAsr';
import { FasterWhisperStt } from './core/voice/FasterWhisperStt';
import { PiperTts } from './core/voice/PiperTts';
import { VoiceStackHealth } from './core/voice/VoiceStackHealth';
import { VOICE_FIX, isReachable } from './core/voice/VoiceFallbacks';
import { PushToTalkService } from './core/voice/PushToTalkService';
import { LoopbackRecorder } from './core/audio/LoopbackRecorder';
import { MicRecorder } from './core/audio/MicRecorder';
import { AudioRouter, findCable } from './core/audio/AudioRouter';
import { CommandHUD } from './overlay/CommandHUD';
import { GlobalHotkey } from './overlay/GlobalHotkey';
import { PairingOverlay } from './overlay/PairingOverlay';
import { ApiServer } from './api/ApiServer';
import { PairingManager } from './p2p/PairingManager';
import { P2PConnectionManager, P2PConnectionManagerOptions } from './p2p/P2PConnectionManager';
import { MeshBridge } from './p2p/MeshBridge';
import { DeviceRegistry } from './p2p/DeviceRegistry';
import { DeviceHub } from './p2p/DeviceHub';
import { assertCanJoinDevice, deviceLimitLabel } from './p2p/DevicePolicy';
import { DeviceClient } from './p2p/DeviceClient';
import { TaskSyncBridge } from './p2p/TaskSyncBridge';
import { PwaServer } from './mobile/PwaServer';
import { GraphifyContextEngine } from './core/graphify/GraphifyContextEngine';
import { SkillCompiler } from './core/skill/SkillCompiler';
import { CppBackend, NoopBackend } from './core/skill/NativeCompiler';
import { SkillRecorder } from './core/skill/SkillRecorder';
import { SkillRouter } from './core/skill/SkillRouter';
import { CompanionRegistry } from './core/skill/CompanionRegistry';
import { SkillContentIndex } from './core/skill/SkillContentIndex';
import { McpRegistry } from './core/mcp/McpRegistry';
import { McpRouter } from './core/mcp/McpRouter';
import { McpHttpConnector } from './core/mcp/McpHttpConnector';
import { McpServerEndpoint } from './core/mcp/McpServerEndpoint';
import { ExternalRegistrySync, DEFAULT_SOURCES } from './core/mcp/ExternalRegistrySync';
import { OAuthConnector, OAuthTokenSet } from './core/mcp/OAuthConnector';
import { MCP_CATALOG } from './core/mcp/McpCatalog';
import { curatedConnectorForCatalogId } from './core/mcp/curatedTools';
import { ConnectorStore } from './core/mcp/ConnectorStore';
import { ConnectorApi } from './core/mcp/ConnectorApi';
import { OpenConnectorBridge } from './core/mcp/OpenConnectorBridge';
import { ToolIngestion } from './core/mcp/ToolIngestion';
import { VectorToolRegistry } from './core/mcp/VectorToolRegistry';
import { ToolDefinition } from './core/mcp/ToolDefinition';
import { CredentialVault } from './core/vault/CredentialVault';
import { getStableHwid } from './native/win32/HardwareId';
import { LiveShadowEngine } from './core/shadow/LiveShadowEngine';
import { MeetingAgent } from './core/meeting/MeetingAgent';
import { MeetingBotClient } from './core/meetingbot/MeetingBotClient';
import { TelnyxClient } from './core/telco/TelnyxClient';
import { DockerDaemon } from './core/docker/DockerDaemon';
import { StripeBilling } from './core/billing/StripeBilling';
import { TenantLedger } from './core/billing/TenantLedger';
import { HetznerProvisioner } from './core/cloud/HetznerProvisioner';
import { UserStore } from './core/auth/UserStore';
import { MeteringService } from './core/metering/MeteringService';
import { ModelRouter, DEFAULT_ROUTING } from './core/metering/ModelRouter';
import { RoutedLLMConnector } from './core/metering/RoutedLLMConnector';
import { ModelProvider, PlanTier, McpConnectorConfig, McpOauthClientConfig } from './types';
import { ALL_SKILLS } from './core/skill/SkillStack';
import { listSkillRepos } from './core/skill/SkillRepos';
import { SocialAutomation } from './core/social/SocialAutomation';
import { ApprovalGate } from './core/agent/ApprovalGate';
import { createAuthToken } from './api/AuthToken';
import { SignedUrl } from './mobile/SignedUrl';
import { SmartThingsService } from './core/smart/SmartThingsService';
import { SmartHomeScheduler } from './core/smart/SmartHomeScheduler';
import { buildSmartHomeHub } from './core/smart/SmartHomeAdapters';
import type { SmartHomeHub } from './core/smart/SmartHomePlatform';
import { OpenCarruselBridge } from './core/media/OpenCarruselBridge';
import { TwentyBridge } from './core/crm/TwentyBridge';
import { MeetingStore } from './core/meeting/MeetingStore';
import { RecordingService } from './core/audio/RecordingService';
import { VirtualWallet } from './core/billing/VirtualWallet';
import { SmartRoutingMatrix, buildStickySystemPrompt } from './core/metering/SmartRoutingMatrix';
import { normalizeRoutePlan, TASK_TO_SLOT } from './core/metering/pricing';
import Stripe from 'stripe';
import * as crypto from 'crypto';

/**
 * Bridge a legacy ConnectorTool (keyword retrieval shape) into a
 * ToolDefinition so ingested + legacy catalogs share one retrieval contract.
 */
function toolDefFromConnectorTool(t: {
  name: string;
  description: string;
  connectorId: string;
  authType: string;
}): ToolDefinition {
  return {
    tool_id: `${t.connectorId}.execute_action`,
    connector_id: t.connectorId,
    name: 'execute_action',
    natural_language_description: t.description,
    category: 'Catalog',
    parameters_schema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'API endpoint route to hit.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method.' },
        payload: { type: 'object', description: 'JSON payload for body (POST/PUT/PATCH) or query (GET).' },
        endpointTemplate: { type: 'string', description: 'Optional connector-internal route hint.' },
      },
      required: ['endpoint', 'method'],
      additionalProperties: true,
    },
    auth_type: (['none', 'apiKey', 'bearer', 'oauth'].includes(t.authType) ? t.authType : 'none') as ToolDefinition['auth_type'],
    transport: 'rest',
    schema_quality: 'generic',
    source: 'catalog',
  };
}

/** Engine selector: only these three values are valid; anything else falls back to 'browseruse'. */
export type UmbraEngine = 'browseruse' | 'desktop2' | 'ghost';
export function umbraEngine(): UmbraEngine {
  const v = process.env['UMBRA_ENGINE'];
  return v === 'desktop2' || v === 'ghost' ? v : 'browseruse';
}

export class UmbraOS {
  private configManager!: ConfigManager;
  private knowledge!: KnowledgeGraph;
  private bridge!: RecallToKnowledgeBridge;
  private fastEngine!: BrowserUseBridge;
  private deepEngine!: DeepUnderstandingEngine;
  private llm!: LLMConnector;
  private taskPlanner!: TaskPlanner;
  private agent!: AgentRuntime;
  private repos!: ReposManager;
  private consent!: ConsentGate;
  private proactive!: ProactiveAgent;
  private issueWatcher?: IssueWatcher;
  private companionRegistry?: CompanionRegistry;
  private taskStore!: TaskStore;
  private headless: boolean = false;
  private role: 'desktop' | 'cloud' = 'desktop';
  private displayManager!: VirtualDisplayManager;
  private inputGuard!: InputGuard;
  private swarm!: SwarmManager;
  private healer!: SelfHealingGuard;
  private memory!: VectorMemory;
  private watcher?: ActivityWatcher;
  private macros!: MacroSynthesizer;
  private vault!: AuditVault;
  private privacy!: PrivacyGuard;
  private screenReader?: ScreenReader;
  private journal!: JournalGenerator;
  private topicIndexer!: TopicIndexer;
  private desktop2!: Desktop2Environment;
  private realDesktop?: RealDesktop2;
  private agentDesktop?: AgentDesktop;
  private audio!: NoiseCancellationEngine;
  private streamer?: PreviewStreamer;
  /** Shared propose/decide gate for meeting/execute + desktop2/action (OpenMuse actions.ts port). */
  private approvalGate = new ApprovalGate();
  private previewSigned!: SignedUrl;
  private hud?: CommandHUD;
  private hotkey?: GlobalHotkey;
  private pushToTalkHotkey?: GlobalHotkey;
  private pairingOverlay?: PairingOverlay;
  private openmontage!: OpenMontageBridge;
  private videoProducer!: VideoProducer;
  private imageGen!: ImageGenerator;
  private speechToText?: SpeechToText;
  private api!: ApiServer;
  private pairing?: PairingManager;
  private p2p?: P2PConnectionManager;
  private mesh?: MeshBridge;
  private pwa?: PwaServer;
  private deviceRegistry?: DeviceRegistry;
  private deviceHub?: DeviceHub;
  private deviceClient?: DeviceClient;
  private taskSyncBridge?: TaskSyncBridge;
  private graphify!: GraphifyContextEngine;
  private skillCompiler!: SkillCompiler;
  private skillRecorder!: SkillRecorder;
  private skillRouter!: SkillRouter;
  private skillContent!: SkillContentIndex;
  private mcpRegistry!: McpRegistry;
  private mcpRouter!: McpRouter;
  private mcpExternal!: ExternalRegistrySync;
  private mcpServer!: McpServerEndpoint;
  private oauth!: OAuthConnector;
  private connectorStore!: ConnectorStore;
  private connectorApi!: ConnectorApi;
  /** Gateway to oomol-lab/open-connector (1,500+ providers). Attached to the
   *  ConnectorApi so list/connect/execute merge silently; unset = local only. */
  private openConnector?: OpenConnectorBridge;
  private hermes!: HermesAgentBridge;
  private credVault!: CredentialVault;
  private shadow?: LiveShadowEngine;
  private meetings!: MeetingAgent;
  private meetingCompanion?: MeetingCompanion;
  private loopbackRecorder?: LoopbackRecorder;
  private micRecorder?: MicRecorder;
  private pushToTalk?: PushToTalkService;
  private audioRouter?: AudioRouter;
  /** Default mic before routeMeetingMic switched it to the cable (restored on leave). */
  private savedMicDeviceId?: string;
  private windowsTts?: WindowsTts;
  private vibeVoiceTts?: VibeVoiceTts;
  private voiceboxClient?: VoiceboxClient;
  private vibeVoiceAsr?: VibeVoiceAsr;
  private whisperAsr?: WhisperAsr;
  private fasterWhisperStt?: FasterWhisperStt;
  private piperTts?: PiperTts;
  private voiceStackHealth?: VoiceStackHealth;
  private awareness?: ScreenAwareness;
  private telnyx!: TelnyxClient;
  private dockerDaemon!: DockerDaemon;
  private billing?: StripeBilling;
  private userStore?: UserStore;
  private tenants!: TenantLedger;
  private metering!: MeteringService;
  private modelRouter!: ModelRouter;
  private chromeBridge!: ChromeExtensionBridge;
  private social!: SocialAutomation;
  private socialTimer?: ReturnType<typeof setInterval>;
  private smartThings!: SmartThingsService;
  private smartScheduler!: SmartHomeScheduler;
  private smartHomeHub!: SmartHomeHub;
  private smartTimer?: ReturnType<typeof setInterval>;
  private carrusel!: OpenCarruselBridge;
  private twenty!: TwentyBridge;
  private meetingStore?: any;
  private meetingBotClient?: MeetingBotClient;
  private recordingService?: any;
  private virtualWallet?: VirtualWallet;
  private smartRouter!: SmartRoutingMatrix;
  private hetznerProvisioner?: HetznerProvisioner;
  private stripeClient?: Stripe;
  private startedAt: number = Date.now();
  private resumedTasks: number = 0;
  /** True when the credential vault could not be unlocked at boot — surfaced
   *  in /api/status so the UI can prompt "Vault locked — unlock in Settings". */
  public credVaultLocked: boolean = false;
  /** Cached at boot so /api/status does not stat the filesystem per poll. */
  private hermesAvailable: boolean = false;
  /** Tool framework: schema ingestion (curated + OpenAPI + MCP). */
  private toolIngestion?: ToolIngestion;
  /** Tool framework: semantic tool retrieval with keyword fallback. */
  private toolVectorRegistry?: VectorToolRegistry;
  /** Number of tool definitions available for JIT retrieval. */
  public toolsIndexed: number = 0;
  /** LLM boot health (see checkLlmHealth) — never throws, never blocks boot. */
  private llmHealth: {
    provider: string;
    endpoint: string;
    reachable: boolean;
    disabled: boolean;
    error?: string;
    message?: string;
    checkedAt: number;
  } = { provider: '', endpoint: '', reachable: false, disabled: false, checkedAt: 0 };

  private initialized: boolean = false;

  async initialize(dataDir?: string): Promise<void> {
    console.log('🌘 Umbra OS v0.1.0 — initializing...');

    const configManager = new ConfigManager(dataDir);
    await configManager.initialize();
    this.configManager = configManager;
    const config = configManager.raw;

    // ── Execution mode: desktop (full, the user's PC) vs cloud (headless) ──
    //    Cloud runs the core (API, agent loop, MCP, memory, routing) without
    //    Windows-native subsystems, so it stays small on a 4 GB box.
    this.role = process.env.UMBRA_ROLE === 'cloud' ? 'cloud' : 'desktop';
    this.headless = process.env.UMBRA_HEADLESS === '1' || this.role === 'cloud';
    if (this.headless) {
      getLogger().info({ role: this.role }, 'Running in headless/cloud mode — desktop subsystems disabled');
    }

    initializeLogger(config.paths.logsDir, config.logging.level, config.logging.prettyPrint);
    getLogger().info('Umbra OS starting...');

    // ── Knowledge Brain ──────────────────────────────────────
    this.knowledge = new KnowledgeGraph(config.paths.knowledgeDir);
    await this.knowledge.initialize();

    // ── Metering & Plan (tiers + circuit breakers) — created first so
    //    every LLM call is gated, budgeted, and token-accounted. ─────
    this.metering = new MeteringService({
      tier: config.plan.tier,
      dataDir: config.paths.dataDir,
    });
    this.modelRouter = new ModelRouter({
      config,
      persistPath: path.join(config.paths.dataDir, 'routing-usage.json'),
    });

    // ── Multi-user budgets: each registered tenant gets its own router
    //    (tier + $5/$10 monthly ceiling + spend ledger). No tenants => the
    //    node keeps using the default router exactly as before. ───────
    this.tenants = new TenantLedger({ config, dataDir: config.paths.dataDir, defaultRouter: this.modelRouter });

    // ── LLM (routed + metered: tier selection, rate limits, circuit
    //    breaker, token accounting, plan gate) ────────────────────────
    this.llm = new RoutedLLMConnector(config, this.metering, this.modelRouter, this.tenants);

    // ── LLM health check at boot: the default provider is a LOCAL Ollama
    //    (provider: 'ollama', models qwen2.5:*), which is simply not running
    //    on most machines. Probe it once; if it is unreachable, record a
    //    disabled state with a helpful message and keep booting — every AI
    //    task then reports SERVICE_DISABLED instead of a raw connect error.
    await this.checkLlmHealth();

    // ── Privacy Guard ────────────────────────────────────────
    this.privacy = new PrivacyGuard();

    // ── Consent Gate (approval + emergency stop) ─────────────
    this.consent = new ConsentGate({
      dataDir: config.paths.dataDir,
      promptTimeoutMs: 30000,
      askOncePerSession: true,
       autoApprove: config.autoApprove === true,
    });
    if (await this.consent.checkEmergencyStop()) {
      getLogger().warn('Consent gate: emergency-stop file present at startup — actions will be blocked');
    }

    // ── Screen Reader (OCR — reads everything, filters later) ─
    if (!this.headless) {
      this.screenReader = new ScreenReader(this.privacy, { ocrPoolSize: 2 });
      this.screenReader.setLLM(this.llm);
    }

    // ── Screen Awareness (sees the screen + cursor, answers about it) ──
    //    `watch` keeps the latest frame + cursor trail live so mid-task asks
    //    are answered instantly and Umbra always follows the cursor.
    if (!this.headless && this.screenReader && config.awareness.enabled) {
      this.awareness = new ScreenAwareness({
        llm: this.llm,
        screenReader: this.screenReader,
        watchIntervalMs: config.awareness.watchIntervalMs,
        followCursor: config.awareness.followCursor,
      });
      if (config.awareness.watch !== false) {
        this.awareness.startWatching(config.awareness.watchIntervalMs);
      }
    }

    // ── Recall (everything is logged here, vector-indexed) ───
    this.memory = new VectorMemory(config.paths.recallDb, { enableVec: true });
    this.memory.setEmbedder(text => this.llm.createEmbedding(text));
    this.memory.initialize();

    // ── Journal Generator (hourly/daily organized brain) ─────
    this.journal = new JournalGenerator(this.memory, this.knowledge, this.privacy, config.paths.knowledgeDir);
    this.journal.initialize();
    this.topicIndexer = new TopicIndexer(config.paths.knowledgeDir);
    this.topicIndexer.initialize();

    // ── Activity Watcher (watches your every move) — desktop only ──
    if (!this.headless && this.screenReader) {
      this.watcher = new ActivityWatcher(
        this.memory, this.knowledge, this.privacy,
        this.screenReader,
        {
          pollIntervalMs: 2000,
          captureIntervalMs: 2000,
          idleThresholdSec: 120,
          useScreenReader: true,
        },
      );
    }

    // ── Knowledge Bridge (recall → brain) ────────────────────
    this.bridge = new RecallToKnowledgeBridge(this.memory, this.knowledge);
    this.bridge.setLLM(this.llm);

    // ── Virtual Desktop Infrastructure ───────────────────────
    this.displayManager = new VirtualDisplayManager({
      maxDisplays: config.workspace.maxSwarmDisplays,
      displayWidth: config.workspace.displayWidth,
      displayHeight: config.workspace.displayHeight,
      displayFps: config.workspace.displayFps,
    });
    this.inputGuard = new InputGuard();

    this.swarm = new SwarmManager(this.displayManager, this.inputGuard, {
      maxSlots: Math.max(1, config.workspace.maxSwarmDisplays - 1),
      cpuLimit: config.workspace.cpuLimit,
      gpuLimit: config.workspace.gpuLimit,
    });

    this.healer = new SelfHealingGuard(this.displayManager, this.inputGuard);
    this.healer.setLLM(this.llm);

    // ── Vault (crypto audit trail) ───────────────────────────
    this.vault = new AuditVault(config.paths.vaultDir);
    this.vault.initialize();

    // ── Desktop 2 — the isolated AI workspace ────────────────
    this.desktop2 = new Desktop2Environment(
      this.displayManager,
      this.inputGuard,
      this.privacy,
      this.vault,
      {
        width: config.workspace.displayWidth,
        height: config.workspace.displayHeight,
        fps: config.workspace.displayFps,
        browserPath: '',
        dataDir: config.paths.dataDir,
      },
      this.consent,
    );
    // ApprovalGate wiring (called once): desktop2/action consent checks consult the shared gate.
    this.desktop2.setApprovalGate(this.approvalGate, 'desktop2');

    // ── Agent Desktop (persistent agent Chrome with CDP) — desktop only ──
    if (!this.headless) {
      this.agentDesktop = new AgentDesktop(this.consent, path.join(config.paths.dataDir, 'workspace'), {
        path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        cdpPort: 9223,
        profileDir: path.join(config.paths.dataDir, 'chrome-agent-profile'),
      });
    }

    // ── RealDesktop2 — "human mode": real apps + real Chrome on a 2nd desktop ──
    if (!this.headless && this.screenReader) {
      this.realDesktop = new RealDesktop2(
        this.consent,
        this.privacy,
        this.vault,
        this.screenReader,
        {
          chromePath: config.realDesktop.chromePath,
          cdpPort: config.realDesktop.cdpPort,
          windowWidth: config.realDesktop.windowWidth,
          windowHeight: config.realDesktop.windowHeight,
          dataDir: config.paths.dataDir,
        },
      );
    }

    // ── Chrome Extension Bridge (browser telemetry receiver) ──
    this.chromeBridge = new ChromeExtensionBridge(this.memory, this.knowledge, this.privacy, {
      dataDir: config.paths.dataDir,
    });

    // ── Fast Engine (browser-use bridge in the user's Chrome) ──
    this.fastEngine = new BrowserUseBridge(
      path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe'),
      path.join(__dirname, '..', 'scripts', 'browser-use', 'bridge.py'),
    );
    if (!this.fastEngine.isAvailable()) {
      getLogger().warn(
        'BrowserUseBridge: python venv or bridge script missing — fast engine disabled. ' +
          'Falling back to the Desktop2 / Chrome CDP loop (AgentDesktop). ' +
          'Install with: cd backend && python -m venv .venv && .venv\\Scripts\\pip install browser-use && .venv\\Scripts\\python -m playwright install chromium',
      );
    }
    const engine: UmbraEngine = umbraEngine();
    if (engine === 'browseruse' && !this.headless) {
      await this.fastEngine.start();
    } else if (engine === 'browseruse') {
      getLogger().info('Fast engine disabled (headless) — cloud tasks use the step loop / built-in reasoning engine');
    } else {
      getLogger().info(`Fast engine disabled (UMBRA_ENGINE=${engine}) — using Desktop 2 loop`);
    }

    // ── Video production (Remotion + OpenMontage tool registry) ──
    this.openmontage = new OpenMontageBridge();
    this.videoProducer = new VideoProducer(this.llm, this.openmontage);
    this.imageGen = new ImageGenerator(config);
    this.speechToText = new SpeechToText(config);
    this.vibeVoiceTts = new VibeVoiceTts({
      repoDir: path.join(__dirname, '..', 'external', 'VibeVoice'),
      python: path.join(__dirname, '..', 'external', 'VibeVoice', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'),
      model: config.voice.vibevoiceModel,
      device: config.voice.vibevoiceDevice,
      outputDir: path.join(config.paths.dataDir, 'tts'),
    });
    this.voiceboxClient = new VoiceboxClient({ baseUrl: config.voice.voiceboxUrl });
    this.vibeVoiceAsr = new VibeVoiceAsr({ baseUrl: config.voice.vibevoiceAsrUrl });
    this.whisperAsr = new WhisperAsr({ baseUrl: config.voice.whisperAsrUrl });
    this.fasterWhisperStt = new FasterWhisperStt({
      baseUrl: config.voice.fasterWhisperUrl,
      defaultLanguage: config.voice.fasterWhisperLanguage,
    });
    this.piperTts = new PiperTts({
      baseUrl: config.voice.piperUrl,
      defaultVoice: config.voice.piperVoice,
      defaultLanguage: config.voice.piperLanguage,
      outputDir: path.join(config.paths.dataDir, 'tts'),
    });
    if (!this.openmontage.isInstalled()) {
      getLogger().warn(
        'OpenMontage not installed — video production falling back to built-in VideoProducer (Remotion CLI). ' +
          'Install with: cd backend && git clone https://github.com/umbra-os/OpenMontage.git external/OpenMontage && cd external/OpenMontage && pip install -r requirements.txt',
      );
    }
    if (!this.vibeVoiceTts?.installed) {
      getLogger().warn(
        'VibeVoice not installed — TTS/ASR falling back to Piper TTS / Whisper ASR (already configured as alternates). ' +
          'Install with: cd backend && npm run vibevoice:install (needs Python 3.10+ and a GPU recommended)',
      );
    }

    // ── Agent Systems ────────────────────────────────────────
    this.taskPlanner = new TaskPlanner(this.knowledge, this.llm, this.memory);
    this.repos = new ReposManager(config.repos);
    // Durable task queue — in-flight tasks survive restarts, and a cloud node
    // can resume the PC's queue when it shares this directory.
    this.taskStore = new TaskStore(path.join(config.paths.dataDir, 'task-queue'));
    this.agent = new AgentRuntime(
      this.llm,
      this.knowledge,
      this.taskPlanner,
      new WorkspaceFiles(path.join(config.paths.dataDir, 'workspace')),
    );
    this.hermes = new HermesAgentBridge({
      // Empty bin = auto-detect (%LOCALAPPDATA%\hermes\hermes.exe and friends,
      // then `hermes` on PATH). Never pass '' — the bridge would treat it as a
      // literal path to the CWD and fail to spawn.
      bin: (config.hermes.bin || '').trim() || undefined,
      timeoutMs: config.hermes.taskTimeoutMs,
    });
    if (!config.hermes.autoDelegate) {
      getLogger().info('Hermes auto-delegation is off (opt-in via hermes.autoDelegate / UMBRA_HERMES_AUTO_DELEGATE=1)');
    }
    if (this.hermes.isInstalled()) {
      this.hermesAvailable = true;
      getLogger().info({ bin: this.hermes.detectBin() }, 'Hermes agent engine detected');
    } else {
      getLogger().warn(
        { bin: config.hermes.bin || '(auto)', searched: '%LOCALAPPDATA%\\hermes, %USERPROFILE%\\.hermes, PATH' },
        'Hermes agent engine NOT found — delegation to the external agent is unavailable (set hermes.bin in config.json, HERMES_BIN, or install hermes)',
      );
    }

    this.agent.registerSubsystems({
      swarm: this.swarm,
      healer: this.healer,
      memory: this.memory,
      vault: this.vault,
      consent: this.consent,
      desktop2: this.desktop2,
      realDesktop: this.realDesktop,
      agentDesktop: this.agentDesktop,
      bridge: this.fastEngine,
      openmontage: this.openmontage,
      videoProducer: this.videoProducer,
      repos: this.repos,
      hermes: this.hermes,
      autoDelegate: config.hermes.autoDelegate,
      taskStore: this.taskStore,
      nodeRole: this.role,
      // Vault-backed injection guard: quarantined prompt-injection hits in
      // untrusted observations (OCR, page text, tool results) are recorded in
      // the tamper-evident audit log, not just logged to the console.
      injectionGuard: new InjectionGuard({ vault: this.vault }),
      // JIT connector-tool retrieval for native function calling (M3): the
      // built-in reasoning engine gets top-K ToolDefinitions per prompt.
      connectorToolRetrieval: async (prompt, k = 6) => {
        if (this.toolVectorRegistry) {
          return (await this.toolVectorRegistry.search(prompt, k)).map(r => r.def);
        }
        return (await this.connectorApi.getRelevantTools(prompt, k)).map(toolDefFromConnectorTool);
      },
    });

    // ── Deep Understanding (LLM-powered research & expansion) ─
    this.deepEngine = new DeepUnderstandingEngine(this.memory, this.knowledge);
    this.deepEngine.setLLM(this.llm);

    // ── Proactive Agent (acts without being asked) — desktop only ──
    if (!this.headless && this.watcher) {
      this.proactive = new ProactiveAgent(this.memory, this.knowledge, this.watcher, this.bridge, this.deepEngine);
      this.proactive.setAgent(this.agent);
      this.proactive.setLLM(this.llm);
    }

    // ── Macro Synthesizer ────────────────────────────────────
    this.macros = new MacroSynthesizer(this.memory);
    this.macros.setLLM(this.llm);
    this.macros.setAgent(this.agent);

    // ── Audio DSP ────────────────────────────────────────────
    this.audio = new NoiseCancellationEngine(config.audio.gestureCooldownMs);

    // ── Preview Streamer (real frames from Desktop 2 via ws) — desktop only ──
    if (!this.headless) {
      this.streamer = new PreviewStreamer({
        enabled: true,
        port: 9090,
        fps: 5,
      });
      this.streamer.setFrameProvider(() => this.realDesktop?.captureWindow() ?? this.desktop2.screenshot());
      const ghostEngine = umbraEngine() !== 'browseruse';
      this.streamer.setCommandHandler((action, params) =>
        ghostEngine ? this.executeGhost(action, params) : this.desktop2.executeAction(action, params),
      );
      // AuthToken + SignedUrl wiring (OpenMuse auth.ts port): opt-in via
      // UMBRA_PREVIEW_AUTH=1 so local dev stays open by default.
      this.previewSigned = new SignedUrl(createAuthToken(path.join(config.paths.dataDir, 'auth'), ''));
      if (process.env['UMBRA_PREVIEW_AUTH'] === '1') {
        this.streamer.setAuth(this.previewSigned.authToken);
      } else {
        // Enforced only when UMBRA_PREVIEW_AUTH=1 — otherwise leave open.
        this.streamer.setAuth(null);
      }
    }

    // ── Command HUD — desktop only ────────────────────────────
    if (!this.headless) {
      this.hud = new CommandHUD();
      this.hud.registerSubsystems({
        agent: this.agent,
        macros: this.macros,
        config: this.configManager,
        knowledge: this.knowledge,
        screenAsk: (q, intent) => this.screenAsk(q, intent),
      });

      // Global hotkey (Ctrl+Shift+Space) toggles the ask overlay. The
      // listener polls GetAsyncKeyState through the NativeCore daemon and
      // emits overlay:toggle, which the HUD handles.
      const hudHotkey = config.hotkeys.pause || 'Ctrl+Shift+Space';
      if (hudHotkey) {
        this.hotkey = new GlobalHotkey({ combo: hudHotkey, pollMs: 200 });
        this.hotkey.start();
      }
    }

    // ── API Server (REST + WS for the read-only UI) ──────────
    this.api = new ApiServer({
      getStatus: () => this.getApiStatus(),
      submitTask: (description, priority, idempotencyKey) => this.submitTask(description, priority, idempotencyKey),
      chat: (message, target) => this.dispatchTask(message, target || 'auto'),
      getTask: id => this.agent.getTask(id),
      getActiveTasks: () => this.agent.getActiveTasks(),
      getTaskActivity: id => Promise.resolve(this.agent.getTaskActivity(id)),
      cancelTask: taskId => this.agent.cancelTask(taskId),
      retryTask: (taskId, description) => this.agent.retryTask(taskId, description),
      workerClaim: (taskId, workerId) => this.agent.workerClaim(taskId, workerId),
      workerHeartbeat: (taskId, workerId) => this.agent.workerHeartbeat(taskId, workerId),
      workerRelease: (taskId, workerId) => this.agent.workerRelease(taskId, workerId),
      workerRecover: (workerId) => this.agent.workerRecover(workerId),
      proposeAction: (taskId, action, args) => this.agent.proposeAction(taskId, action, args),
      reviewAction: (proposalId, approved, hash) => this.agent.reviewAction(proposalId, approved, hash),
      getProposal: (proposalId) => this.agent.getProposal(proposalId),
      listProposals: (taskId) => this.agent.listProposals(taskId),
      requestInput: (taskId, question, options) => this.agent.requestInput(taskId, question, options),
      submitInput: (taskId, inputId, answer) => this.agent.submitInput(taskId, inputId, answer),
      executeDesktop2: (action, params) => this.executeDesktop2(action, params),
      executeGhost: (action, params) => this.executeGhost(action, params),
      captureGhost: () => this.captureGhost(),
      requestConsent: reason => this.requestConsent(reason),
      getConsentState: () => this.consent.getState(),
      isEmergencyStopArmed: () => this.consent.isEmergencyStopArmed(),
      armEmergencyStop: () => this.consent.armEmergencyStop(),
      disarmEmergencyStop: () => this.consent.disarmEmergencyStop(),
      searchKnowledge: q => this.searchKnowledge(q),
      getMacros: () => this.getMacros(),
      getSessions: () => this.getSessions(),
      getPrivacyStats: () => this.getPrivacyStats(),
      getActivitySummary: () => this.getActivitySummary(),
      getSwarmStatus: () => this.getSwarmStatus(),
      getAuditStats: () => this.getAuditStats(),
      getRepos: () => this.getRepos(),
      getMcpCatalog: opts => this.getMcpCatalog(opts),
      connectMcp: (id, opts) => this.connectMcp(id, opts),
      disconnectMcp: id => this.disconnectMcp(id),
      beginMcpOauth: (id, redirectUri) => this.beginMcpOauth(id, redirectUri),
      completeMcpOauth: (code, state) => this.completeMcpOauth(code, state),
      getMcpOauthStatus: id => this.getMcpOauthStatus(id),
      refreshMcpOauth: id => this.refreshMcpOauth(id),
      syncExternalConnectors: opts => this.syncExternalConnectors(opts),
      syncExternalSources: opts => this.syncExternalMcpSources(opts),
      getModelStatus: () => this.getModelStatus(),
      getPlanUsage: tenantId => this.getPlanUsage(tenantId),
      testLlm: () => this.testLlm(),
      configureProvider: patch => this.configureProvider(patch),
      activatePlan: (tier, tenantId) => this.activatePlan(tier, tenantId),
      billingCreateCheckout: (tier, tenantId) => this.billing!.createCheckoutSession(tier, tenantId),
      tenantsList: async () => this.tenants.statuses(),
      tenantsRegister: async opts => this.tenants.register({ ...opts, tier: opts.tier as PlanTier | undefined }),
      tenantsActivate: async (id, tier) => this.tenants.activate(id, tier),
      tenantsDisable: async id => this.tenants.disable(id),
      billingHandleWebhook: (rawBody, signature) => this.billing!.handleWebhook(rawBody, signature),
      handleStripeWebhook: (rawBody, signature) => this.handleStripeWebhookJIT(rawBody, signature),
      getSmartRoute: async (userId, taskType, preferAlt) => this.getSmartRoute(userId, taskType as any, preferAlt),
      deductWallet: async (userId, model, usage) => this.deductWalletForUsage(userId, model, usage),
      getWallet: async (userId) => this.getWalletBalance(userId),
      getProviderConfig: () => this.getProviderConfig(),
      listOpenMontageTools: () => this.listOpenMontageTools(),
      generateImage: (prompt, opts) => this.generateImage(prompt, opts),
      getVoiceStatus: () => this.getVoiceStatus(),
      getVoiceStackHealth: refresh => this.getVoiceStackHealth(refresh),
      transcribeAudio: (audio, opts) => this.transcribeAudio(audio, opts),
      voiceCommand: (audio, opts) => this.voiceCommand(audio, opts),
      speakText: (text, opts) => this.speakOut(text, opts),
      listTtsVoices: () => this.listTtsVoices(),
      recallMemory: q => this.recallMemory(q),
      rememberMemory: text => this.rememberMemory(text),
      screenAsk: (question, intent) => this.screenAsk(question, intent),
      screenState: () => this.screenState(),
      screenLive: () => this.screenLive(),
      screenWatch: enabled => this.screenWatch(enabled),
      meetingJoin: (url, opts) => this.meetingJoin(url, opts),
      meetingStartListening: () => this.meetingStartListening(),
      meetingStatus: () => this.meetingStatus(),
      meetingLeave: () => this.meetingLeave(),
      meetingExecute: (action, params) => this.meetingExecute(action, params),
      meetingFeedAudio: (audio, format) => this.meetingFeedAudio(audio, format),
      meetingShare: target => this.meetingShare(target),
      meetingStopShare: () => this.meetingStopShare(),
      meetingOrders: () => this.meetingOrders(),
      meetingSpeak: (text, opts) => this.meetingSpeak(text, opts),
      meetingMute: muted => this.meetingMute(muted),
      meetingRaiseHand: raised => this.meetingRaiseHand(raised),
      meetingChat: message => this.meetingChat(message),
      meetingBotJoin: (url, platform, name) => this.meetingBotClient!.joinMeeting({ meeting_url: url, platform: platform as 'google_meet' | 'teams', bot_name: name }),
      meetingBotLeave: () => this.meetingBotClient!.leaveMeeting(),
      meetingBotStatus: () => this.meetingBotClient!.getStatus(),
      meetingBotTranscript: () => this.meetingBotClient!.getTranscript(),
      meetingBotCommand: (cmd, args) => this.meetingBotClient!.sendCommand(cmd, args),
      listAudioDevices: () => this.listAudioDevices(),
      setAudioDefault: opts => this.setAudioDefault(opts),
      getMeetings: () => Promise.resolve(this.meetingStore ? this.meetingStore.list() : []),
      getMeeting: (id: string) => Promise.resolve(this.meetingStore ? this.meetingStore.get(id) : null),
      startLoopback: (seconds?: number) => this.recordingService ? this.recordingService.startLoopback(seconds) : Promise.reject(new Error('Recording service not ready')),
      stopLoopback: (id: string) => this.recordingService ? this.recordingService.stop(id) : Promise.reject(new Error('Recording service not ready')),
      listRecordings: () => Promise.resolve(this.recordingService ? this.recordingService.list() : []),
      listDevices: () => this.getDevices(),
      createDeviceInvite: name => this.createDeviceInvite(name),
      joinDevice: (code, meta) => this.joinDevice(code, meta),
      revokeDevice: deviceId => this.revokeDevice(deviceId),
      sendToDevice: (deviceId, msg) => this.sendToDevice(deviceId, msg),
      delegateHermes: (description, opts) => this.agent.delegateTask(description, opts),
      generateJournalNow: () => this.generateJournalNow(),
      compileHotSkills: threshold => this.compileHotSkills(threshold),
      telcoSendSms: opts => this.telnyx.sendSms(opts),
      telcoCall: opts => this.telnyx.initiateCall(opts),
      configureTelco: patch => this.configureTelco(patch),
      getTelcoStatus: () => this.getTelcoStatus(),
      dockerRun: spec => this.dockerDaemon.run(spec),
      dockerStop: name => this.dockerDaemon.stop(name),
      dockerRemove: name => this.dockerDaemon.remove(name),
      dockerList: () => Promise.resolve(this.dockerDaemon.list()),
      exportTaskQueue: () => this.exportTaskQueue(),
      importTaskQueue: payload => this.importTaskQueue(payload),
      getMeshStatus: () => this.meshStatus(),
      meshPair: ttl => this.meshPair(ttl),
      meshPairDemo: () => this.meshPairDemo(),
      meshRevoke: deviceId => this.meshRevoke(deviceId),
      mcpHandle: message => this.mcpServer.handle(message),
      // Auth (web app)
      authSignup: async (email, password, name) => this.userStore!.signup(email, password, name) || Promise.reject(new Error('Email already taken')),
      authLogin: async (email, password) => this.userStore!.login(email, password) || Promise.reject(new Error('Invalid credentials')),
      authLoginWithKey: async (apiKey) => this.userStore!.loginWithApiKey(apiKey) || Promise.reject(new Error('Invalid API key')),
      authListDevices: async (apiKey) => { const user = this.userStore!.loginWithApiKey(apiKey); if (!user) throw new Error('Invalid API key'); return this.userStore!.listDevices(user.id); },
      authPairDevice: async (apiKey, name, type) => { const user = this.userStore!.loginWithApiKey(apiKey); if (!user) throw new Error('Invalid API key'); const plan = this.userStore!.getPlan(user.id); if (!plan.mobileApp && type === 'phone') throw new Error('Pro plan required for mobile app'); return this.userStore!.pairDevice(user.id, name, type) || Promise.reject(new Error('Device limit reached')); },
      authRemoveDevice: async (apiKey, deviceId) => { const user = this.userStore!.loginWithApiKey(apiKey); if (!user) throw new Error('Invalid API key'); return this.userStore!.removeDevice(user.id, deviceId); },
      authGetPlan: async (apiKey) => { const user = this.userStore!.loginWithApiKey(apiKey); if (!user) throw new Error('Invalid API key'); return { ...this.userStore!.getPlan(user.id), user: { email: user.email, name: user.name, plan: user.plan } }; },
      handleChromeTelemetry: (events, sessionId, cookieSnapshot) =>
        this.chromeBridge.handleTelemetry(events as any, sessionId, cookieSnapshot as any),
      getChromeExtensionStatus: () => this.chromeBridge.getStatus(),
      getChromeLoginEvents: () => this.chromeBridge.getLoginEvents(),
      approveChromeLogin: async (url, provider, username) => this.chromeBridge.approveLogin(url, provider, username),
      getChromeCookies: async (domain) => this.chromeBridge.getChromeCookies(domain),
      getChromeSites: async () => this.chromeBridge.getChromeSites(),
      getConnectedConnectors: () => this.chromeBridge.getConnectedConnectors(),
      disconnectConnector: async (connectorId) => this.chromeBridge.disconnectConnector(connectorId),
      // Social
      socialPost: opts => this.socialPost(opts),
      socialSchedule: opts => this.socialSchedule(opts),
      socialScheduled: () => this.socialScheduled(),
      socialCancelSchedule: id => this.socialCancelSchedule(id),
      socialStatus: () => this.socialStatus(),
      smartDevices: () => this.smartDevices(),
      smartCommand: (deviceId, command) => this.smartCommand(deviceId, command),
      smartControlByName: (name, command) => this.smartControlByName(name, command),
      smartSchedules: () => this.smartSchedules(),
      smartScheduleAdd: rule => this.smartScheduleAdd(rule),
      smartScheduleCancel: id => this.smartScheduleCancel(id),
      smartStatus: () => this.smartStatus(),
      smartSetToken: token => this.smartSetToken(token),
      smartClearToken: () => this.smartClearToken(),
      smartPlatforms: () => this.smartPlatforms(),
      smartConnectPlatform: (key, token, url) => this.smartConnectPlatform(key, token, url),
      smartDisconnectPlatform: key => this.smartDisconnectPlatform(key),
      smartOauthStart: (key, redirectUri) => this.smartOauthStart(key, redirectUri),
      smartOauthCallback: (key, code, state) => this.smartOauthCallback(key, code, state),
      getVaultEntries: () => this.getVaultEntries(),
      setVaultEntry: entry => this.setVaultEntry(entry),
      deleteVaultEntry: id => this.deleteVaultEntry(id),
      // Carrusel
      carruselStart: () => this.carruselStart(),
      carruselStop: () => this.carruselStop(),
      carruselStatus: () => this.carruselStatus(),
      carruselCreate: opts => this.carruselCreate(opts),
      carruselList: () => this.carruselList(),
      carruselGet: id => this.carruselGet(id),
      carruselAddSlide: opts => this.carruselAddSlide(opts),
      carruselChat: opts => this.carruselChat(opts),
      carruselExport: id => this.carruselExport(id),
      carruselDelete: id => this.carruselDelete(id),
      carruselBrand: () => this.carruselBrand(),
      carruselDuplicate: id => this.carruselDuplicate(id),
      // Twenty CRM
      twentyStart: () => this.twentyStart(),
      twentyStop: () => this.twentyStop(),
      twentyStatus: () => this.twentyStatus(),
      twentyGraphql: opts => this.twentyGraphql(opts),
      // ── Connector Marketplace ────────────────────────────────
      listConnectors: opts => this.connectorApi.listConnectors(opts),
      getConnector: id => this.connectorApi.getConnector(id),
      getConnectorCategories: () => this.connectorApi.getConnectorCategories(),
      connectConnector: (id, opts) => this.connectorApi.connectConnector(id, opts),
      completeConnectorOauth: (id, code, state, userId) => this.connectorApi.handleOAuthCallback(id, code, state, userId),
      getConnectorReadiness: (id, userId) => this.connectorApi.getReadiness(id, userId),
      getConnectorReadinessSummary: userId => this.connectorApi.getReadinessSummary(userId),
      getConnectorStatus: (id, userId) => this.connectorApi.getConnectorStatus(id, userId),
      disconnectConnectorApi: (id, userId) => this.connectorApi.disconnectConnector(id, userId),
      executeConnectorAction: (connectorId, endpoint, method, payload, userId) =>
        this.connectorApi.executeConnectorAction(connectorId, endpoint, method, payload, userId),
      getRelevantTools: (query, limit) => this.connectorApi.getRelevantTools(query, limit),
      listToolSchemas: opts => this.connectorApi.listToolSchemas(opts),
      getConnectorTools: id => this.connectorApi.getConnectorTools(id),
      ingestConnectorOpenApi: opts => this.ingestConnectorOpenApi(opts),
      ensureConnectorTools: (id, opts) => this.ensureConnectorTools(id, opts),
      syncConnectorCatalog: () => this.connectorApi.syncCatalog(),
      saveConnectorCredential: (slug, clientId, clientSecret, scopes) =>
        this.connectorApi.saveDeveloperCredential(slug, clientId, clientSecret, scopes),
      shutdown: () => {
        if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT');
      },
    }, 8787);

    // ── Credential Vault (AES-256-GCM, HWID-bound) ────────────
    this.credVault = new CredentialVault({
      dataDir: config.paths.dataDir,
      hwid: getStableHwid(process.env['UMBRA_HWID']),
    });
    this.credVaultLocked = true;
    try {
      this.credVault.unlock();
      this.credVaultLocked = !this.credVault.isUnlocked;
    } catch (err) {
      this.credVaultLocked = true;
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Credential vault locked — vault-backed connectors are disabled until you unlock it in Settings',
      );
    }
    if (this.credVaultLocked) {
      // Surfaced in /api/status → credVault.locked so the UI can show
      // "Vault locked — unlock in Settings" instead of failing silently.
      getLogger().warn(
        { entries: this.credVault.isUnlocked ? this.credVault.list().length : 0 },
        'Credential vault is LOCKED — stored connector/API credentials are unavailable (unlock in Settings)',
      );
      eventBus.emit('vault:entry', 'locked');
    }
    // Wire chrome bridge to vault + consent for auto-register logins
    try { this.chromeBridge.setVault(this.credVault); this.chromeBridge.setConsent(this.consent); } catch {}

    // ── GitHub issue → task loop (watch repos, ship PRs) ──────
    // New open issues are routed through CompanionRegistry, dispatched as
    // tasks (same path as POST /api/chat), and their completed summary is
    // posted back as an issue comment. Gated on config.github.enabled with
    // the PAT read from the credential vault.
    if (config.github?.enabled && (config.github.repositories?.length ?? 0) > 0) {
      this.companionRegistry = new CompanionRegistry();
      const gh = config.github;
      this.issueWatcher = new IssueWatcher({
        repositories: gh.repositories ?? [],
        stateFile: path.join(config.paths.dataDir, 'github-watcher-state.json'),
        token: () =>
          this.credVault.isUnlocked ? (this.credVault.find(gh.tokenService ?? 'github')?.secret ?? null) : null,
        requestConsent: reason => this.consent.request(reason),
        route: title => this.companionRegistry!.best(title).id,
        dispatchTask: async description => {
          const dispatch = await this.dispatchTask(description, 'auto');
          return dispatch.taskId;
        },
        pollIntervalMs: gh.pollIntervalMs,
        labels: gh.labels,
        assignedTo: gh.assignedTo,
        consentRequired: gh.consentRequired !== false,
        commentResults: gh.commentResults !== false,
      });
      // When a dispatched task completes, post its summary back on the issue.
      eventBus.on('task:completed', (taskId: string, result: unknown) => {
        const summary = result && typeof result === 'object' ? (result as { summary?: string }).summary : undefined;
        void this.issueWatcher?.postResult(taskId, summary ?? '');
      });
    }

    // ── MCP registry + router (vault-backed HTTP connectors) ──
    this.mcpRegistry = new McpRegistry();
    const httpConnector = new McpHttpConnector({ vault: this.credVault });
    this.mcpRouter = new McpRouter(this.mcpRegistry, {
      connector: httpConnector,
      // Dynamically-dispatched native tools: OpenMontage registers itself by
      // tool name, so the resolver looks the binding up at call time.
      nativeResolver: binding => {
        if (binding.skill !== 'openmontage') return undefined;
        return async (input: Record<string, unknown>) => {
          const result = await this.openmontage.runTool(binding.tool, input);
          if (!result.success) throw new Error(result.error || `OpenMontage tool ${binding.tool} failed`);
          return result.data;
        };
      },
    });
    // Expose Umbra's connectors as an MCP server so the built-in reasoning
    // engine can call them through the same vault-gated router.
    this.mcpServer = new McpServerEndpoint(this.mcpRegistry, this.mcpRouter);
    this.mcpExternal = new ExternalRegistrySync(this.mcpRegistry, { dedupe: true });
    this.oauth = new OAuthConnector();

    // ── Connector Marketplace (SQLite-backed user connections + REST executor) ──
    this.connectorStore = new ConnectorStore(
      path.join(config.paths.dataDir, 'connectors.db'),
    );

    // ── Tool framework: ingestion + vector registry (RAG for tools) ──
    try {
      this.toolIngestion = new ToolIngestion(path.join(config.paths.dataDir, 'connectors.db'));
      this.toolIngestion.loadCurated();
      // Generic fallback: every catalog entry gets a `call_api` definition so
      // the whole catalog (3,892 entries) is discoverable AND executable, not
      // just the curated/OpenAPI-covered subset. Idempotent (skips indexed).
      try {
        this.toolIngestion.seedGenericTools(MCP_CATALOG as never);
      } catch (seedErr) {
        getLogger().warn({ err: (seedErr as Error).message }, 'Generic tool seeding skipped');
      }
      this.toolVectorRegistry = new VectorToolRegistry(
        path.join(config.paths.dataDir, 'tool-vectors.db'),
      );
      const allDefs = this.toolIngestion.listAll();
      this.toolVectorRegistry.registerDefinitions(allDefs);
      this.toolVectorRegistry.setKeywordSearch((query, limit) =>
        // Keyword fallback bridges the legacy catalog (3,893 entries) into the
        // definition world: same ranking as before, ToolDefinition shape out.
        this.connectorApi.getRelevantTools(query, limit).then(tools => tools.map(toolDefFromConnectorTool)),
      );
      // Semantic mode uses the configured embedder; when unreachable,
      // search() automatically falls back to the keyword path above.
      this.toolVectorRegistry.setEmbedder(text => this.llm.createEmbedding(text));
      // Boot-time indexing is fire-and-forget: unchanged tools are cached by
      // text hash, so restarts after the first run cost nothing.
      void this.toolVectorRegistry.index(allDefs).then(n => {
        this.toolsIndexed = this.toolVectorRegistry!.status().indexed;
        getLogger().info({ embedded: n, status: this.toolVectorRegistry!.status() }, 'Tool vector registry ready');
      }).catch(() => {});
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, 'Tool framework init failed — connectors fall back to generic mode');
    }

    this.connectorApi = new ConnectorApi(this.connectorStore, this.oauth, {
      ingestion: this.toolIngestion,
      injectionGuard: new InjectionGuard({ vault: this.vault }),
      mcpCall: async (connectorId, tool, input) => {
        if (!this.mcpRouter) throw new Error('MCP router not initialized');
        const r = await this.mcpRouter.call(connectorId, tool, input);
        if (!r.ok) throw new Error(r.error || 'MCP call failed');
        return r.output;
      },
      maxAttempts: 3,
    }, this.toolIngestion);

    // ── Open-connector gateway (1,500+ providers, invisible to users) ──
    // Sidecar at OPENCONNECTOR_BASE_URL (default 127.0.0.1:3000). When it's
    // down, every ConnectorApi path degrades to the local catalog — boot is
    // never blocked by the gateway. See backend/docs/open-connector-bridge.md.
    try {
      this.openConnector = new OpenConnectorBridge();
      this.connectorApi.setOpenConnector(this.openConnector);
      const bridge = this.openConnector;
      void bridge.isAvailable().then(ok =>
        getLogger().info({ ok, base: bridge.getBaseUrl() }, 'Open-connector gateway status'));
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, 'Open-connector gateway disabled — local connectors only');
    }

    // ── P2P: pairing + signaling + PWA control plane — desktop only ──
    if (config.p2p.enabled && !this.headless) {
      // Rust mesh daemon (optional transport): zero-knowledge identity +
      // QR pairing + paired-device store. Graceful when not built.
      this.mesh = new MeshBridge({
        enabled: config.p2p.meshEnabled !== false,
        dataDir: path.join(config.paths.dataDir, 'mesh'),
        name: 'umbra-desktop',
      });
      const meshStarted = await this.mesh.start();
      if (meshStarted.ok) {
        getLogger().info('Umbra mesh daemon running (P2P Rust transport)');
      } else {
        getLogger().debug({ reason: meshStarted.reason }, 'Umbra mesh daemon not started');
      }

      this.pairing = new PairingManager({ dataDir: config.paths.dataDir });
      const pairing = this.pairing;
      const p2pOptions: P2PConnectionManagerOptions = {
        signalingPort: config.p2p.signalingPort,
        pairing,
        stunServers: config.p2p.stunServers,
        turnServers: config.p2p.turnServers,
        relayFps: config.p2p.relayFps,
      };
      const p2p = new P2PConnectionManager(p2pOptions);
      this.p2p = p2p;
      p2p.start();
      const pwa = new PwaServer({
        webPort: config.p2p.webPort,
        signalingPort: config.p2p.signalingPort,
        pairing,
        getStatus: () => {
          const status = p2p.getStatus();
          return {
            active: status.active,
            clients: status.clients,
            pairedDevices: status.pairedDevices,
          };
        },
        onChat: (message, target) => this.dispatchTask(message, target || 'auto'),
        getActiveTasks: () => this.agent.getActiveTasks(),
        getTask: id => this.agent.getTask(id),
        onCancelTask: taskId => this.agent.cancelTask(taskId),
        onRetryTask: (taskId, description) => this.agent.retryTask(taskId, description),
        getDeviceInfo: () => this.getDevices(),
        getPushToTalkStatus: () => this.getPushToTalkStatus(),
        onSetPushToTalk: (combo, enabled) => this.updatePushToTalk(combo, enabled),
      });
      this.pwa = pwa;
      pwa.start();
      // Tray QR overlay for phone pairing (Windows-only)
      if (pairing) {
        try {
          this.pairingOverlay = new PairingOverlay(config.paths.dataDir);
          void this.pairingOverlay.start({
            getLink: () => `http://localhost:${config.p2p.webPort}`,
            getPayloadJson: () => {
              try { return JSON.stringify((pairing as any).createSession('localhost', config.p2p.signalingPort)); } catch { return '{}'; }
            },
          }).catch(() => {});
        } catch {}
      }

      // Phone control plane drives the real desktop (or Desktop 2) and
      // streams live frames back to the PWA.
      p2p.setCommandHandler((action, params) =>
        umbraEngine() !== 'browseruse'
          ? this.executeGhost(action, params)
          : this.executeDesktop2(action, params),
      );
      p2p.setFrameProvider(async () => this.realDesktop?.captureWindow() ?? this.desktop2.screenshot());
    }

    // ── Device mesh (always-on hub + auto-reconnecting client) ──
    //    Every node runs a DeviceHub so a phone can pair directly on the LAN
    //    or a cloud box can be the single always-on hub. When hubUrl is set,
    //    this node ALSO connects as a client to that remote hub and stays
    //    connected forever (auto-reconnect + persisted token).
    if (config.devices.enabled) {
      this.deviceRegistry = new DeviceRegistry({ dataDir: config.paths.dataDir });
      this.deviceHub = new DeviceHub({ registry: this.deviceRegistry, port: config.devices.hubPort });
      this.deviceHub.start();
      // Broadcast task lifecycle events to every paired device ("Portals"): a
      // task started on the phone appears, updates, and can be cancelled on
      // the desktop, and vice versa. Starts after the hub so connected devices
      // receive snapshots as soon as they join.
      this.taskSyncBridge = new TaskSyncBridge({
        broadcast: msg => this.deviceHub?.broadcast(msg),
        getTask: id => this.agent.getTask(id),
        node: this.role,
        // Also push each lifecycle snapshot directly to the device that
        // submitted the task, so the phone tracks its own work live.
        relayTo: (deviceId, msg) => this.deviceClient?.relay(deviceId, msg),
        // Broadcast already reaches locally-connected devices — skip the
        // direct relay for those so the origin doesn't get every event twice.
        isBroadcastCovered: deviceId => this.deviceHub?.isOnline(deviceId) ?? false,
      });
      this.taskSyncBridge.start();
      this.startDeviceClient();
    }

    // ── Graphify/Caveman — context compression pipeline ───────
    this.graphify = new GraphifyContextEngine({
      targetChunkTokens: config.graphify.chunkTokens,
      targetTokens: config.graphify.summaryTokens,
      summarize: async (text, maxTokens) => {
        const res = await this.llm.complete(
          [{ role: 'user', content: `Summarize the following in at most ${maxTokens ?? 300} tokens:\n\n${text}` }],
          'fast',
        );
        return res.content;
      },
      embeddings: async (text: string) => {
        try { return await this.llm.createEmbedding(text); } catch { return []; }
      },
    });

    // ── Master Skill Stack + compiler + recorder + router ─────
    this.skillRecorder = new SkillRecorder({ dataDir: config.paths.dataDir });
    this.skillRouter = new SkillRouter();
    this.skillContent = new SkillContentIndex();
    this.skillCompiler = new SkillCompiler({
      outDir: config.compiler.outputDir,
      compileHot: config.compiler.enabled && config.compiler.backend !== 'none',
      backend: this.nativeBackend(config.compiler.backend),
    });

    // Register the 100-skill catalog into the MCP registry so the skill
    // router can dispatch <skill>.execute through the McpRouter, and hand
    // the intelligence layer (skills / graphify / metering / mcp) to the
    // agent runtime for step execution.
    for (const skill of ALL_SKILLS) {
      this.mcpRegistry.register(skill.id, 'execute', { transport: 'prompt' });
    }

    // ── OpenMontage tool registry (external video suite) ──────────
    // Discover the installed OpenMontage tools and expose each as a native
    // MCP tool so the agent loop can produce video through the same router.
    this.syncOpenMontageTools().catch(() => getLogger().debug('OpenMontage tool sync skipped'));
    this.agent.registerSubsystems({
      skillRouter: this.skillRouter,
      skillRecorder: this.skillRecorder,
      skillContent: this.skillContent,
      mcpRouter: this.mcpRouter,
      metering: this.metering,
      graphify: this.graphify,
      agentConnectorBridge: this.connectorApi.getAgentConnectorBridge(),
    });

    // ── Smart Home: the agent is given its Smart Home surface further down, once
    // the hub and scheduler have actually been constructed.

    // ── Live Shadowing (real screen watch + takeover) — desktop only ──
    if (!this.headless) {
      this.shadow = new LiveShadowEngine({
        captureIntervalMs: Math.round(1000 / config.shadow.fps),
        captureWindow: true,
      });
    }

    // ── Meeting Agent + Telco (Telnyx) + Docker workers ───────
    this.meetings = new MeetingAgent({
      summarize: async (transcript: string) => {
        const res = await this.llm.complete(
          [{ role: 'user', content: `Summarize this meeting in at most 300 tokens:\n\n${transcript}` }],
          'fast',
        );
        return res.content;
      },
    });
    this.meetingBotClient = new MeetingBotClient({
      botUrl: process.env.MEETING_BOT_URL || 'http://127.0.0.1:8000',
      plan: process.env.MEETING_BOT_PLAN || 'free',
    });
    this.telnyx = new TelnyxClient({
      fromNumber: config.telco.fromNumber,
      vault: this.credVault,
    });
    // ── User Store (must exist before billing for wallet/JIT) ──
    if (!this.userStore) {
      this.userStore = new UserStore(path.join(config.paths.dataDir, 'users.db'));
    }

    // ── JIT Infrastructure: Smart Routing + Virtual Wallet ─────────
    this.smartRouter = new SmartRoutingMatrix();
    this.virtualWallet = new VirtualWallet(this.userStore);
    // Hetzner JIT: cx22 (PRO €3.79) / cx33 (ADVANCED €6.49), image=docker-ce, location=nbg1
    this.hetznerProvisioner = new HetznerProvisioner({
      apiToken: config.cloud?.hetznerApiToken || process.env.HETZNER_API_TOKEN || '',
      sshKeyName: config.cloud?.sshKeyName || 'umbra-cloud',
      location: 'nbg1',
      image: 'docker-ce',
      umbraImage: config.cloud?.umbraImage,
      publicUrl: config.cloud?.publicUrl || config.billing.publicUrl,
    });
    // alias for closure
    const hetzner = this.hetznerProvisioner;
    if (config.billing.secretKey) {
      try { this.stripeClient = new Stripe(config.billing.secretKey, { apiVersion: '2024-06-20' as any }); } catch {}
    }

    // ── Billing (Stripe checkout + webhook) ─────────────────────
    // Payment completes on Stripe's hosted checkout; the webhook verifies the
    // signature and activates the plan (token budget auto-assigned by tier).
    this.billing = new StripeBilling({
      secretKey: config.billing.secretKey,
      webhookSecret: config.billing.webhookSecret,
      priceIds: config.billing.priceIds,
      publicUrl: config.billing.publicUrl,
      onPlanPaid: async (tier, tenantId) => {
        // Normalize tier alias
        const jitTier = tier === 'ultimate' ? 'advanced' : tier;
        await this.activatePlan(jitTier, tenantId);
        if (!tenantId) return;
        // Find or create user for wallet linkage (tenantId may be userId or tenant::user)
        const user = this.userStore!.getUserById(tenantId) || this.userStore!.getUserById(tenantId.split('::').pop()!);
        const targetUserId = user ? user.id : tenantId;
        // JIT wallet: Pro=5, Advanced=10, Enterprise=30 models
        const budgets = this.virtualWallet!.getBudgets(jitTier);
        try { this.virtualWallet!.init(targetUserId, jitTier); } catch {}
        // JIT Hetzner VPS provisioning
        if (hetzner.enabled) {
          const result = await hetzner.provision(targetUserId, jitTier);
          if (result.serverId) {
            try { this.virtualWallet!.linkServer(targetUserId, result.serverId); } catch {}
            try { this.userStore!.setHetznerServerId(targetUserId, result.serverId); } catch {}
          }
          getLogger().info({ userId: targetUserId, tier: jitTier, serverId: result.serverId, ip: result.ip, cost: result.estimatedCost, budgets }, 'JIT Cloud VPS provisioned');
        }
      },
      onSubscriptionCanceled: async (customerId, _subscriptionId) => {
        // JIT teardown: lookup serverId from DB first, then fallback to fuzzy list
        try {
          const user = this.userStore!.findByStripeCustomerId(customerId);
          if (user) {
            const sid = this.userStore!.getHetznerServerId(user.id);
            if (sid && hetzner.enabled) {
              await hetzner.teardown(sid);
              getLogger().info({ serverId: sid, customerId, userId: user.id }, 'JIT VPS destroyed on subscription.deleted (DB lookup)');
              return;
            }
          }
        } catch {}
        if (hetzner.enabled) {
          const servers = await hetzner.listUmbraServers();
          for (const s of servers) {
            if (s.name.includes(customerId.slice(0, 8))) {
              await hetzner.teardown(s.id);
              getLogger().info({ serverId: s.id, customerId }, 'JIT VPS torn down on subscription.deleted (fallback fuzzy)');
            }
          }
        }
      },
    });
    this.dockerDaemon = new DockerDaemon({
      dryRun: !config.docker.enabled,
      registry: undefined,
    });

    // ── Social Automation (X.com + YouTube + Instagram via Playwright) ──
    this.social = new SocialAutomation(
      path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe'),
      path.join(__dirname, '..', 'scripts'),
      config.paths.dataDir,
    );
    if (!this.social.isAvailable()) {
      getLogger().warn(
        'SocialAutomation: python venv not available — using no-op scheduler fallback (posts will be logged as "not configured"). ' +
          'Install with: cd backend && python -m venv .venv && .venv\\Scripts\\pip install -r scripts/social/requirements.txt && .venv\\Scripts\\python -m playwright install chromium',
      );
    }

    // ── Smart Home (Samsung SmartThings) ─────────────────────
    this.smartThings = new SmartThingsService({
      enabled: config.smartthings?.enabled ?? false,
      token: config.smartthings?.token || '',
      baseUrl: config.smartthings?.baseUrl || 'https://api.smartthings.com',
    }, this.credVault as any);

    // ── Smart Home hub — multi-platform (SmartThings + HA + Hubitat + openHAB + Tuya + Hive + Homey + Apple/Alexa/Google bridges) ──
    this.smartHomeHub = buildSmartHomeHub({ vault: this.credVault as any, smartThings: this.smartThings, config: (config as any).smartHome });

    // Schedules route through the hub so rules on Home Assistant, Hubitat, Tuya, etc.
    // run too. Rules saved before the hub existed hold a bare SmartThings id, so
    // those keep going to the legacy service.
    this.smartScheduler = new SmartHomeScheduler({
      sendCommand: async (deviceId, command) => (deviceId.includes(':')
        ? this.smartHomeHub.sendCommand(deviceId, command)
        : this.smartThings.sendCommand(deviceId, command)),
    }, config.paths.dataDir || undefined);

    // ── Smart Home: give the agent its control surface (hub + scheduler) ──
    // Registered here, not earlier, so these are the real instances.
    this.agent.registerSmartHome(this.smartThings, this.smartScheduler);
    this.agent.registerSmartHomeHub(this.smartHomeHub);

    // ── Open Carrusel (AI-powered Instagram carousel designer) ──
    this.carrusel = new OpenCarruselBridge(
      path.join(__dirname, '..', 'external', 'open-carrusel'),
      3100,
    );
    if (!this.carrusel.isInstalled()) {
      getLogger().warn(
        'OpenCarrusel not installed — Instagram carousel designer unavailable. ' +
          'Install with: cd backend && git clone https://github.com/umbra-os/open-carrusel.git external/open-carrusel && cd external/open-carrusel && npm install && npm run dev',
      );
    }

    // ── Twenty CRM (open-source Salesforce alternative, Docker Compose) ──
    this.twenty = new TwentyBridge(
      path.join(__dirname, '..', 'external', 'twenty', 'packages', 'twenty-docker'),
      config.paths.dataDir,
      { serverUrl: `http://127.0.0.1:3000`, port: 3000 },
    );
    if (!this.twenty.isAvailable()) {
      getLogger().warn(
        'Twenty CRM Docker stack not found — using local SQLite-backed CRM fallback. ' +
          'Install with: cd backend && git clone https://github.com/twentyhq/twenty.git external/twenty',
      );
    }

    // ── Recording + Meeting persistence (always, even headless for API) ──
    this.meetingStore = new MeetingStore(config.paths.dataDir);
    this.recordingService = new RecordingService(config.paths.dataDir);

    // ── Meeting Companion (join/hear/act/leave) — desktop only ──
    if (!this.headless) {
      this.loopbackRecorder = new LoopbackRecorder({ dataDir: config.paths.dataDir });
      this.audioRouter = new AudioRouter({ dataDir: config.paths.dataDir });
      this.windowsTts = new WindowsTts(config.paths.dataDir);
      this.meetingCompanion = new MeetingCompanion({
        stt: this.speechToText.available
          ? {
              transcribe: async (audio: Buffer, format?: string) => {
                const r = await this.speechToText!.transcribe({ audio, format: format as 'wav' | 'mp3' | 'webm' });
                // A provider that is not listening degrades instead of throwing;
                // the meeting just loses the transcript chunk, not the meeting.
                if (!r.ok) getLogger().warn({ error: r.error, fix: r.hint }, 'Meeting transcript skipped — STT provider not running');
                return { text: r.text };
              },
            }
          : undefined,
        diarize: config.voice.asrProvider === 'vibevoice' || config.voice.asrProvider === 'whisper'
          ? {
              transcribe: async (audio: Buffer, _format?: string) => {
                if (config.voice.asrProvider === 'whisper') {
                  if (!this.whisperAsr || !(await this.whisperAsr.isRunning())) {
                    throw new Error('Whisper-ASR server not running — start it with `npm run whisper:asr-server`');
                  }
                  return this.whisperAsr.transcribe(audio, {
                    context: this.configManager.raw.voice.vibevoiceAsrContext || undefined,
                  });
                }
                if (!this.vibeVoiceAsr || !(await this.vibeVoiceAsr.isRunning())) {
                  throw new Error('VibeVoice-ASR server not running — start it with `npm run vibevoice:asr-server`');
                }
                return this.vibeVoiceAsr.transcribe(audio, {
                  context: this.configManager.raw.voice.vibevoiceAsrContext || undefined,
                });
              },
            }
          : undefined,
        recorder: config.meeting.loopbackEnabled ? this.loopbackRecorder : undefined,
        onJoin: url =>
          this.realDesktop
            ? this.realDesktop.openChrome(url)
            : Promise.resolve('Real desktop unavailable — open the meeting URL manually'),
        onExecute: (action, params) => this.executeGhost(action, params),
        onShareScreen: target => this.shareScreenInMeeting(target),
        onStopShare: () => this.stopScreenShareInMeeting(),
        onMeetingControl: control =>
          control === 'mute' || control === 'unmute'
            ? this.controlMeetingMic(control === 'mute')
            : this.controlMeetingHand(control === 'raise_hand'),
        onChatMessage: message => this.chatInMeeting(message),
        onSearch: query => this.searchForMeeting(query),
        onNote: text => this.noteForMeeting(text),
        onReminder: text => this.reminderForMeeting(text),
        onSpeak: (text, opts) => this.speakForMeeting(text, opts),
        summarize: async (transcript: string) => {
          const res = await this.llm.complete(
            [{ role: 'user', content: `Summarize this meeting in at most 300 tokens:\n\n${transcript}` }],
            'fast',
          );
          return res.content;
        },
        chunkSec: config.meeting.chunkSec,
        ordersEnabled: config.meeting.ordersEnabled !== false,
      });
      // ApprovalGate wiring (called once): meeting/execute consent checks consult the shared gate.
      this.meetingCompanion.setApprovalGate(this.approvalGate, 'meeting');

      // ── Voice-stack health: validate STT / TTS / ASR / cable / loopback
      //    at boot (and on demand via GET /api/voice/health). Reported in
      //    /api/status under `voiceStack`. Never fails boot. ──
      this.voiceStackHealth = new VoiceStackHealth({
        config: {
          sttProvider: config.voice.sttProvider ?? 'none',
          tts: config.meeting.tts ?? 'none',
          asrProvider: config.voice.asrProvider ?? 'none',
          audioCable: config.meeting.audioCable ?? 'none',
          loopbackEnabled: config.meeting.loopbackEnabled === true,
          micEnabled: config.voice.enabled === true && Boolean(config.voice.pushToTalk),
        },
        probes: {
          stt: async () => {
            const provider = config.voice.sttProvider ?? 'none';
            const sttFix = this.speechToText?.fixCommand ?? VOICE_FIX.sttBrowser;
            const sttFallback = "the desktop app's Web Speech API (on-device, no server)";
            if (provider === 'openai') {
              const hasKey = !!(config.openai?.apiKey || config.voice.sttApiKey);
              return hasKey
                ? { ok: true, detail: 'OpenAI Whisper: API key configured' }
                : { ok: false, error: 'OpenAI Whisper selected but no API key configured (openai.apiKey or voice.sttApiKey)' };
            }
            if (provider === 'whisper-local') {
              if (!this.speechToText?.available) return { ok: true, detail: 'whisper-local disabled — using browser/cloud STT', status: 'degraded' } as any;
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 3000);
              try {
                const endpoint = (config.voice.sttEndpoint || 'http://localhost:8080').replace(/\/health\/?$/, '');
                const healthUrl = endpoint.replace(/\/+$/, '') + '/health';
                const res = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
                if (!res.ok) return { ok: true, detail: `whisper-local at ${healthUrl} returned HTTP ${res.status} — fallback to cloud STT`, status: 'degraded' } as any;
                return { ok: true, detail: `whisper-local reachable at ${healthUrl}` };
              } catch (err: any) {
                return { ok: true, detail: `whisper-local not running — using ${sttFallback}`, error: `whisper-local unreachable: ${err.message}`, status: 'degraded', fix: sttFix, fallback: sttFallback } as any;
              } finally {
                clearTimeout(timer);
              }
            }
            if ((provider as string) === 'voicebox') {
              const running = this.voiceboxClient ? await this.voiceboxClient.isRunning().catch(() => false) : false;
              return running
                ? { ok: true, detail: 'Voicebox STT ready at ' + (config.voice.voiceboxUrl || 'http://127.0.0.1:17493') }
                : { ok: true, status: 'degraded', error: 'Voicebox not running — using ' + sttFallback, detail: `Voice STT degraded — using ${sttFallback}`, fix: VOICE_FIX.sttVoicebox, fallback: sttFallback } as any;
            }
            if (provider === 'faster-whisper') {
              const url = (config.voice.fasterWhisperUrl || 'http://127.0.0.1:17510').replace(/\/+$/, '') + '/health';
              try {
                const res = await HttpBridge.request({ url, method: 'GET', timeoutMs: 5000 });
                const data: any = res.data || {};
                if (data?.state === 'ready' || data?.ok) return { ok: true, detail: `Faster-Whisper STT ready at ${url} (${data.model || 'base'})` };
                return { ok: true, status: 'degraded', error: `Faster-Whisper at ${url} not ready: ${data?.state || res.status}`, detail: `Voice STT degraded — using ${sttFallback}`, fix: VOICE_FIX.sttFasterWhisper, fallback: sttFallback } as any;
              } catch (e: any) {
                return { ok: true, status: 'degraded', error: `Faster-Whisper at ${config.voice.fasterWhisperUrl} unreachable: ${e.message}`, detail: `Voice STT degraded — using ${sttFallback}`, fix: VOICE_FIX.sttFasterWhisper, fallback: sttFallback } as any;
              }
            }
            return { ok: false, error: `Unknown STT provider: ${provider}` };
          },
          tts: async () => {
            const tts = config.meeting.tts ?? 'none';
            const sapi = 'Windows SAPI (built into Windows)';
            if (tts === 'local') {
              return this.windowsTts?.available
                ? { ok: true, detail: 'Windows SAPI TTS available' }
                : { ok: false, error: 'Windows SAPI TTS unavailable (Windows only)' };
            }
            if (tts === 'vibevoice') {
              return this.vibeVoiceTts?.installed
                ? { ok: true, detail: 'VibeVoice venv installed (npm run vibevoice:install)' }
                : { ok: true, status: 'degraded', error: 'VibeVoice not installed', detail: `Voice TTS degraded — using ${sapi}`, fix: VOICE_FIX.ttsVibeVoice, fallback: sapi } as any;
            }
            if (tts === 'voicebox') {
              const running = this.voiceboxClient ? await this.voiceboxClient.isRunning().catch(() => false) : false;
              return running
                ? { ok: true, detail: 'Voicebox API running at ' + (config.voice.voiceboxUrl || 'http://127.0.0.1:17493') }
                : { ok: true, status: 'degraded', error: 'Voicebox not running', detail: `Voice TTS degraded — using ${sapi}`, fix: VOICE_FIX.ttsVoicebox, fallback: sapi } as any;
            }
            if (tts === 'piper') {
              const url = (config.voice.piperUrl || 'http://127.0.0.1:17520').replace(/\/+$/, '') + '/health';
              try {
                const res = await HttpBridge.request({ url, method: 'GET', timeoutMs: 5000 });
                const data: any = res.data || {};
                if (data?.ok || data?.state === 'ready') return { ok: true, detail: `Piper TTS ready at ${url} voice ${data.voice || config.voice.piperVoice}` };
                return { ok: true, status: 'degraded', error: `Piper at ${url} not ready: ${data?.state || res.status}`, detail: `Voice TTS degraded — using ${sapi}`, fix: VOICE_FIX.ttsPiper, fallback: sapi } as any;
              } catch (e: any) {
                return { ok: true, status: 'degraded', error: `Piper at ${config.voice.piperUrl} unreachable: ${e.message}`, detail: `Voice TTS degraded — using ${sapi}`, fix: VOICE_FIX.ttsPiper, fallback: sapi } as any;
              }
            }
            return { ok: false, error: `Unknown TTS provider: ${tts}` };
          },
          asr: async () => {
            const provider = config.voice.asrProvider ?? 'none';
            const plainStt = 'plain STT without speaker labels';
            if (provider === 'whisper') {
              const health = this.whisperAsr ? await this.whisperAsr.health().catch(() => null) : null;
              if (!health) {
                return { ok: true, detail: `Whisper-ASR not running — diarization uses ${plainStt}`, error: 'Whisper-ASR not running', status: 'degraded', fix: VOICE_FIX.asrWhisper, fallback: plainStt } as any;
              }
              if (health.state === 'loading') {
                return { ok: true, detail: 'Whisper-ASR loading — model downloading/loading (first run ~520 MB)', status: 'degraded', fallback: plainStt, fix: VOICE_FIX.asrWhisper } as any;
              }
              if (health.state === 'error') {
                return { ok: true, detail: `Whisper-ASR error — fallback to basic STT`, error: `Whisper-ASR failed: ${health.error ?? 'unknown'}`, status: 'degraded', fallback: plainStt, fix: VOICE_FIX.asrWhisper } as any;
              }
              return { ok: true, detail: `Whisper-ASR ready on ${health.device ?? 'auto'}` };
            }
            if (provider === 'vibevoice') {
              const health = this.vibeVoiceAsr ? await this.vibeVoiceAsr.health().catch(() => null) : null;
              if (!health) {
                return { ok: true, detail: `VibeVoice-ASR not running — diarization via ${plainStt}`, error: 'VibeVoice-ASR not running', status: 'degraded', fix: VOICE_FIX.asrVibeVoice, fallback: plainStt } as any;
              }
              if (health.state === 'loading') {
                return { ok: true, detail: 'VibeVoice-ASR loading — model downloading/loading (first run is ~17 GB)', status: 'degraded', fallback: plainStt, fix: VOICE_FIX.asrVibeVoice } as any;
              }
              if (health.state === 'error') {
                return { ok: true, detail: `VibeVoice-ASR error — fallback`, error: `VibeVoice-ASR failed: ${health.error ?? 'unknown'}`, status: 'degraded', fallback: plainStt, fix: VOICE_FIX.asrVibeVoice } as any;
              }
              return { ok: true, detail: `VibeVoice-ASR ready on ${health.device ?? 'auto'}` };
            }
            return { ok: true, detail: 'ASR disabled — using basic STT', status: 'degraded' } as any;
          },
          cable: async () => {
            const cable = config.meeting.audioCable ?? 'none';
            if (!this.audioRouter) return { ok: true, detail: 'Audio router unavailable — meeting audio via feedAudio API', status: 'degraded' } as any;
            const devices = await this.audioRouter.listDevices('both').catch(() => []);
            if (cable === 'auto') {
              const found = findCable(devices, 'render');
              if (!found) return { ok: true, detail: 'No VB-Cable — meeting audio via browser/ASR feedAudio, or install VB-Cable for cable routing', error: 'No virtual audio cable — install VB-Cable (vb-audio.com/Cable)', status: 'degraded', fix: VOICE_FIX.cable, fallback: 'the browser/ASR feedAudio API' } as any;
              return {
                ok: true,
                detail: `VB-Cable found (${found.name}); default mic ${config.meeting.routeMic ? 'will route to the cable on join' : 'unchanged'}`,
              };
            }
            if (cable === 'none') return { ok: true, detail: 'Audio cable disabled — feedAudio API mode', status: 'degraded' } as any;
            const match = devices.find(d => d.id === cable || d.name === cable);
            return match
              ? { ok: true, detail: `Cable device present: ${match.name}` }
              : { ok: true, status: 'degraded', error: `Configured cable device not found: ${cable}`, detail: `Cable "${cable}" not found — using the default render device`, fix: VOICE_FIX.cable, fallback: 'the default render device' } as any;
          },
          loopback: async () => {
            return this.loopbackRecorder?.available
              ? { ok: true, detail: 'WASAPI loopback capture available' }
              : { ok: true, status: 'degraded', error: 'Loopback capture unavailable (WASAPI disabled or blocked)', detail: 'Loopback capture unavailable — Umbra cannot hear system audio; meeting audio falls back to the browser/ASR feed', fix: VOICE_FIX.loopback, fallback: 'the browser/ASR feedAudio path' } as any;
          },
          mic: async () => {
            if (!this.audioRouter) return { ok: false, error: 'Audio router unavailable', fix: VOICE_FIX.mic } as any;
            const devices = await this.audioRouter.listDevices('capture').catch(() => []);
            return devices.length > 0
              ? {
                  ok: true,
                  detail: `Microphone present: ${devices.map(d => d.name).slice(0, 3).join(', ')}${devices.length > 3 ? '…' : ''}`,
                }
              : { ok: false, error: 'No microphone capture device found — push-to-talk cannot hear you', fix: VOICE_FIX.mic } as any;
          },
        },
      });
      // Run once at boot (never blocks startup on failure). A dead STT/TTS
      // server is a warning, not a boot failure.
      this.voiceStackHealth
        .refresh()
        .then(report => {
          getLogger().info({ degraded: report.degraded, fixes: report.fixes }, report.summary);
          this.voiceStackHealth?.logReport(getLogger());
        })
        .catch(err => getLogger().debug({ err: err?.message }, 'Voice-stack health check failed'));

      // ── Push-to-talk ("tap to listen"): hold the hotkey, speak, release —
      //    the microphone is captured (MicRecorder, waveIn), transcribed by
      //    the configured STT, routed through the skill stack, submitted as a
      //    task, and answered back with a spoken confirmation. Desktop-only
      //    (Windows waveIn) and gated on voice.enabled + a configured
      //    pushToTalk hotkey + an available STT provider. ──
      this.armPushToTalk(config.voice.pushToTalk || '');
    }

    // ── Start subsystems ─────────────────────────────────────
    await this.swarm.initialize();
    await this.desktop2.start();
    this.streamer?.start();
    this.api.start();

    // ── Hidden engine: expose the connector bridge to the agent CLI ──
    // Registers Umbra's /mcp server (all catalog connectors, vault-backed)
    // with the built-in reasoning engine's config, so delegated agentic work
    // can call every connector through Umbra. Idempotent and non-blocking.
    // Umbra's own LLM key is also provisioned to the engine so it runs with
    // the same credentials the app already uses.
    if (config.hermes.enabled) {
      const engineEnv: Record<string, string> = {};
      // Provision the OpenRouter key so Hermes can use it for agentic tasks
      if (config.openrouterApiKey) engineEnv['OPENROUTER_API_KEY'] = config.openrouterApiKey;
      if (config.provider === 'openai' && config.openai?.apiKey) engineEnv['OPENAI_API_KEY'] = config.openai.apiKey;
      if (config.provider === 'anthropic' && config.anthropic?.apiKey) engineEnv['ANTHROPIC_API_KEY'] = config.anthropic.apiKey;
      if (config.provider === 'openai-compatible' && config.openaiCompatible?.apiKey) {
        engineEnv['OPENAI_API_KEY'] = config.openaiCompatible.apiKey;
        // Also set OPENROUTER_API_KEY if not already set (for OpenRouter-backed setups)
        if (!engineEnv['OPENROUTER_API_KEY']) engineEnv['OPENROUTER_API_KEY'] = config.openaiCompatible.apiKey;
      }
      this.hermes
        .registerMcpBridge(`http://127.0.0.1:8787/mcp`)
        .then(() => this.hermes.syncProviderCredentials(engineEnv))
        .catch(() => getLogger().debug('Agent engine bridge registration skipped'));
    }

    this.watcher?.start();
    this.healer.start(5000);
    this.audio.start();
    this.proactive?.start();
    this.issueWatcher?.start();

    // ── Live Shadowing (watch + takeover the real screen) ────
    if (config.shadow.enabled && this.shadow) {
      this.shadow.start();
    }

    // ── MCP connectors from config + full catalog (vault-backed credentials)
    //    Deploy the entire catalog into config so every connector is visiable
    //    and registered, and mark those the user has enabled as connected.
    await this.configManager.syncConnectorCatalog();
    const deployedConnectors = this.configManager.raw.mcp.connectors;
    for (const connector of deployedConnectors) {
      this.mcpRegistry.register(connector.id, connector.tool || 'invoke', {
        endpoint: connector.enabled && connector.baseUrl ? connector.baseUrl : undefined,
        credentialService: connector.credentialKey || connector.name,
        apiKeyHeader: connector.apiKeyHeader,
        authType: connector.authType,
      });
    }

    getLogger().info({ tools: this.mcpRegistry.list().length, connectors: deployedConnectors.length, engine: config.hermes.enabled }, 'MCP registry ready');

    // ── Agent browser: launch once at boot, reused by all tasks ──
    // (ghost/desktop2 modes own Chrome themselves — RealDesktop2 uses the
    //  user's REAL profile; let the agent-chrome instance start on demand)
    if (umbraEngine() === 'browseruse') {
      this.agentDesktop?.ensure().catch(() => {});
    }

    // ── Generate initial journal for yesterday (catch up) ────
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    this.journal.generateDailyJournal(yesterday).catch(() => {});

    // ── Auto-journal every hour ──────────────────────────────
    setInterval(() => {
      this.journal.generateDailyJournal().catch(() => {});
      this.topicIndexer.rebuildIndex();
    }, 3600000);

    // ── Recall → knowledge bridge every 15 minutes ───────────
    setInterval(() => {
      this.bridge.ingestSince(new Date(Date.now() - 15 * 60 * 1000)).catch(() => {});
    }, 15 * 60 * 1000);

    // ── Macro synthesis pass every 30 minutes ────────────────
    setInterval(() => {
      this.macros.analyzePatterns().catch(() => {});
    }, 30 * 60 * 1000);

    this.initialized = true;
    eventBus.emit('app:ready');

    // ── Social scheduler: check for due posts every 30 seconds ──
    this.socialTimer = setInterval(() => {
      this.social.runDue().catch(() => {});
    }, 30_000);

    // ── Smart-home scheduler: run due device rules every 30 seconds ──
    if (this.smartThings.isConfigured()) {
      this.smartTimer = setInterval(() => {
        this.smartScheduler.runDue().catch(() => {});
      }, 30_000);
    }

    // ── Resume in-flight tasks from the durable queue ──────────
    //    Desktop always resumes its own queue; cloud resumes only for paid
    //    plans (cloud continuation is not part of the free plan).
    this.resumedTasks = await this.agent.resumePendingTasks(this.role, config.plan.tier);

    getLogger().info({
      provider: config.provider,
      model: config.models.reasoning,
      swarmSlots: config.workspace.maxSwarmDisplays,
      headless: this.headless,
      role: this.role,
      resumedTasks: this.resumedTasks,
    }, 'Umbra OS initialized');

    console.log('🌘 Umbra OS ready. Command HUD: Ctrl+Shift+Space');
    console.log('👁  Screen reader active — reads everything, filters private data');
    console.log('🔒 Privacy guard active — sensitive content masked before storage');
    console.log('📓 Journaling active — hourly organized notes in knowledge graph');
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * On-demand OpenAPI ingestion for one connector (admin/API route): ingest
   * into tool_definitions, then refresh the vector registry WITHOUT a restart
   * — the evicted connector's old vectors are dropped and the replacement set
   * re-embedded (hash-cache skips unchanged tools).
   */
  private async ingestConnectorOpenApi(opts: {
    connectorId: string;
    spec?: unknown;
    specUrl?: string;
    baseUrl?: string;
    authType?: string;
    apiKeyHeader?: string;
    replace?: boolean;
    maxTools?: number;
  }): Promise<unknown> {
    const result = await this.connectorApi.ingestOpenApiSpec(opts);
    await this.refreshToolVectors(result.connectorId);
    return result;
  }

  /**
   * One-click enable for name-only catalog rows: ingest the connector's
   * known OpenAPI spec when it has no tools yet (no-op when already
   * indexed), then refresh the vector registry WITHOUT a restart.
   */
  private async ensureConnectorTools(id: string, opts?: { force?: boolean }): Promise<unknown> {
    const result = await this.connectorApi.ensureConnectorTools(id, opts ?? {});
    await this.refreshToolVectors(result.connectorId);
    return result;
  }

  /**
   * Drop the connector's stale vectors and re-embed the replacement set
   * (hash-cache skips unchanged tools). A refresh failure never fails the
   * request — definitions are already stored and keyword fallback works.
   */
  private async refreshToolVectors(connectorId: string): Promise<void> {
    try {
      if (this.toolVectorRegistry && this.toolIngestion) {
        this.toolVectorRegistry.evictConnector(connectorId);
        const defs = this.toolIngestion.listAll();
        this.toolVectorRegistry.registerDefinitions(defs);
        const embedded = await this.toolVectorRegistry.index({ force: false });
        getLogger().info(
          { connectorId, embedded, indexed: this.toolVectorRegistry.status().indexed },
          'Vector registry refreshed after OpenAPI ingestion',
        );
      }
    } catch (err) {
      // Definitions are already stored and keyword fallback still works;
      // a vector refresh failure must not fail the ingestion request.
      getLogger().warn(
        { connectorId, err: (err as Error).message },
        'Vector re-index after ingestion failed — new tools stay keyword-retrievable',
      );
    }
  }

  private async getApiStatus(): Promise<Record<string, unknown>> {
    const streamerStatus = this.streamer?.getStreamStatus ? this.streamer.getStreamStatus() : null;
    const swarmStatus = this.swarm ? await this.swarm.getStatus() : null;
    return {
      initialized: this.initialized,
      uptimeMs: Date.now() - this.startedAt,
      consent: this.consent ? {
        ...this.consent.getState(),
        emergencyStopArmed: this.consent.isEmergencyStopArmed(),
      } : null,
      desktop2: this.desktop2 ? this.desktop2.getState() : null,
      realDesktop: this.realDesktop ? this.realDesktop.getState() : null,
      agentDesktop: this.agentDesktop ? { open: this.agentDesktop.isOpen() } : null,
      streamer: streamerStatus,
      agent: this.agent ? { activeTasks: this.agent.getActiveTasks().length } : null,
      swarm: swarmStatus,
      models: this.configManager.raw.models,
      // Boot-time LLM probe: the UI shows the actionable message here instead
      // of every task failing with a raw provider connect error.
      llm: {
        ...this.llmHealth,
        disabled: this.llmHealth.disabled,
        message: this.llmHealth.message
          || (this.llmHealth.disabled ? 'LLM provider unavailable' : 'LLM provider ready'),
      },
      // Credential vault state — `locked: true` ⇒ "Vault locked — unlock in
      // Settings" in the UI; vault-backed connectors stay disabled.
      credVault: {
        locked: this.credVaultLocked,
        available: !!this.credVault?.isUnlocked,
        message: this.credVaultLocked ? 'Vault locked — unlock in Settings' : 'Vault unlocked',
      },
      // Tool framework status — retrieval mode + definition counts for the
      // connectors UI / health dashboards.
      tools: this.toolVectorRegistry
        ? { ...this.toolVectorRegistry.status(), definitions: this.toolIngestion?.count() ?? 0 }
        : { mode: 'keyword', indexed: 0, dimension: null, vecExtension: false, embedder: false, definitions: this.toolIngestion?.count() ?? 0 },
      hermes: {
        configured: this.hermesAvailable,
        autoDelegate: this.configManager.raw.hermes?.autoDelegate === true,
        message: this.hermesAvailable
          ? 'Agent engine available'
          : 'Hermes agent engine not found — delegation unavailable',
      },
      execution: {
        role: this.role,
        headless: this.headless,
        resumedTasks: this.resumedTasks,
        cloudContinuation: this.configManager.raw.plan.cloudContinuation === true,
        plan: this.configManager.raw.plan.tier,
      },
      devices: this.deviceHub ? this.deviceHub.getStatus() : null,
      voiceStack: this.voiceStackHealth ? this.voiceStackHealth.snapshot() : null,
      pushToTalk: this.getPushToTalkStatus(),
      chromeExtension: this.chromeBridge.getStatus(),
      bridges: {
        fastEngine: {
          available: this.fastEngine?.isAvailable() ?? false,
          ready: this.fastEngine?.isReady() ?? false,
          fallback: 'Desktop2 / Chrome CDP loop (AgentDesktop)',
          message: this.fastEngine?.isAvailable()
            ? (this.fastEngine.isReady() ? 'Fast engine running' : 'Fast engine available but not started (headless or disabled)')
            : 'BrowserUseBridge not installed — using Desktop2 / Chrome CDP loop fallback',
        },
        openmontage: {
          available: this.openmontage?.isInstalled() ?? false,
          fallback: 'VideoProducer (Remotion CLI)',
          message: this.openmontage?.isInstalled()
            ? 'OpenMontage installed'
            : 'OpenMontage not installed — using built-in VideoProducer (Remotion CLI) fallback',
        },
        vibevoice: {
          available: this.vibeVoiceTts?.installed ?? false,
          fallback: 'Piper TTS / Whisper ASR',
          message: this.vibeVoiceTts?.installed
            ? 'VibeVoice installed'
            : 'VibeVoice not installed — using Piper TTS / Whisper ASR as alternates',
        },
        social: {
          available: this.social?.isAvailable() ?? false,
          fallback: 'no-op scheduler (logs "not configured")',
          message: this.social?.isAvailable()
            ? 'Social automation available'
            : 'Social automation not configured — using no-op scheduler fallback',
        },
        carrusel: {
          available: this.carrusel?.isInstalled() ?? false,
          fallback: 'none (carousel design unavailable)',
          message: this.carrusel?.isInstalled()
            ? 'OpenCarrusel installed'
            : 'OpenCarrusel not installed — Instagram carousel design unavailable',
        },
        twenty: {
          available: this.twenty?.available ?? false,
          running: this.twenty?.isRunning() ?? false,
          fallback: 'local SQLite-backed CRM',
          message: this.twenty?.available
            ? (this.twenty.isRunning() ? 'Twenty CRM running' : 'Twenty CRM available but not started')
            : 'Twenty CRM Docker stack not found — using local SQLite-backed CRM',
        },
      },
    };
  }

  async submitTask(description: string, priority?: number, idempotencyKey?: string): Promise<string> {
    if (!this.initialized) throw new Error('Umbra OS not initialized');
    const task = await this.agent.submitTask(description, priority, idempotencyKey);
    return task.id;
  }

  /**
   * Hybrid dispatch: the cloud ALWAYS runs the task, and if a desktop is
   * online it ALSO receives a copy (parallel execution). The phone gets
   * live updates from both via TaskSyncBridge broadcast.
   *
   * target='auto'    → cloud runs + relay to all online desktops
   * target='cloud'   → cloud only
   * target='local'   → cloud only
   * target=deviceId  → that device only (no cloud execution)
   */
  async dispatchTask(description: string, target: string = 'auto'): Promise<{ taskId: string; target: string }> {
    // Specific device: route there only (the device executes)
    if (target !== 'auto' && target !== 'cloud' && target !== 'local') {
      if (!this.deviceHub) throw new Error('Device mesh disabled');
      const reply = await this.deviceHub.request(target, { t: 'task', description });
      return { taskId: String(reply.taskId || ''), target };
    }

    // Cloud always runs the task
    const cloudTaskId = await this.submitTask(description);

    // 'auto': also relay to every online desktop (fire-and-forget, parallel)
    if (target === 'auto') {
      const onlineDesktops = this.findOnlineDesktops();
      for (const deviceId of onlineDesktops) {
        // Fire-and-forget notification so the desktop sees the task appear
        this.deviceHub!.send(deviceId, {
          t: 'task-event',
          event: 'task:created',
          node: 'cloud',
          task: { id: cloudTaskId, description, status: 'pending' },
        });
        // Non-blocking: ask the desktop to also execute this task
        this.deviceHub!.request(deviceId, { t: 'task', description }, 5_000)
          .then((reply) => {
            getLogger().info({ cloudTaskId, desktopTaskId: reply.taskId, deviceId }, 'Desktop also executing task (parallel)');
          })
          .catch(() => {}); // Desktop offline or slow — cloud handles it
      }
      if (onlineDesktops.length > 0) {
        getLogger().info({ cloudTaskId, desktops: onlineDesktops.length }, 'Task running on cloud + relaying to desktops');
      }
      return { taskId: cloudTaskId, target: 'cloud+local' };
    }

    // 'cloud' or 'local': cloud only
    return { taskId: cloudTaskId, target: this.role };
  }

  /** Find ALL online desktops (not just the first one). */
  private findOnlineDesktops(): string[] {
    if (!this.deviceRegistry || !this.deviceHub) return [];
    const desktops: string[] = [];
    for (const d of this.deviceRegistry.listDevices()) {
      if (d.role === 'desktop' && this.deviceHub.isOnline(d.deviceId)) {
        desktops.push(d.deviceId);
      }
    }
    return desktops;
  }

  /** Find a single online desktop (for backwards compat). */
  private findOnlineDesktop(): string | null {
    const desktops = this.findOnlineDesktops();
    return desktops[0] ?? null;
  }

  async executeDesktop2(action: string, params: Record<string, unknown>): Promise<string> {
    if (!this.initialized) throw new Error('Umbra OS not initialized');
    return this.desktop2.executeAction(action, params);
  }

  /** Ghost API — drives the REAL desktop (Desktop 2): real apps, real Chrome
   *  with the user's profile/accounts, real mouse/keyboard input — while the
   *  user keeps using their own desktop. */
  async executeGhost(action: string, params: Record<string, unknown>): Promise<string> {
    if (!this.initialized) throw new Error('Umbra OS not initialized');
    if (!this.realDesktop) throw new Error('Real desktop control unavailable in headless/cloud mode');
    return this.realDesktop.executeAction(action, params);
  }

  /** Capture the current Desktop-2 window as a base64 PNG (for telemetry/UI). */
  async captureGhost(): Promise<string | null> {
    if (!this.initialized || !this.realDesktop) return null;
    const buf = await this.realDesktop.captureWindow();
    return buf ? buf.toString('base64') : null;
  }

  async requestConsent(reason: string): Promise<string> {
    if (!this.initialized) throw new Error('Umbra OS not initialized');
    return this.consent.request(reason);
  }

  async getConsentState(): Promise<any> {
    return this.consent.getState();
  }

  async armEmergencyStop(): Promise<void> {
    this.consent.armEmergencyStop();
  }

  async disarmEmergencyStop(): Promise<void> {
    this.consent.disarmEmergencyStop();
  }

  async getKnowledge(id: string): Promise<any> {
    return this.knowledge.getNode(id);
  }

  async searchKnowledge(query: string): Promise<any> {
    return this.knowledge.search(query);
  }

  async getSwarmStatus(): Promise<any> {
    return this.swarm.getStatus();
  }

  async getAuditStats(): Promise<any> {
    return this.vault.getStats();
  }

  async getVaultEntries(): Promise<any> {
    if (!this.credVault?.isUnlocked) throw new Error('Credential vault is locked');
    return this.credVault.list();
  }

  async setVaultEntry(entry: { service: string; username?: string; secret: string; id?: string }): Promise<any> {
    if (!this.credVault?.isUnlocked) throw new Error('Credential vault is locked');
    if (!entry.service?.trim() || !entry.secret?.trim()) throw new Error('service and secret are required');
    return this.credVault.set({ service: entry.service.trim(), username: entry.username?.trim() || '', secret: entry.secret }, entry.id);
  }

  async deleteVaultEntry(id: string): Promise<any> {
    if (!this.credVault?.isUnlocked) throw new Error('Credential vault is locked');
    const ok = this.credVault.delete(id);
    if (!ok) throw new Error('Entry not found');
    return { deleted: id };
  }

  async getRepos(): Promise<any> {
    return this.repos.statusAll();
  }

  async getMcpCatalog(opts?: { q?: string; category?: string; enabled?: boolean; limit?: number; offset?: number }): Promise<any> {
    await this.configManager.syncConnectorCatalog();
    const config = this.configManager.raw.mcp.connectors;
    const active = this.mcpRegistry.list().filter(t => t.transport === 'http').length;

    // AI categories to exclude
    const AI_CATS = new Set(['AI & ML']);

    let entries = config
      .filter(c => !AI_CATS.has(c.category))
      .map(c => {
        const binding = this.mcpRegistry.resolve(c.id, 'invoke');
        return {
          ...c,
          connected: binding?.transport === 'http',
          registered: binding !== undefined,
          apiKeyConfigured: this.credVault.isUnlocked && typeof this.credVault.find(c.credentialKey || c.name) !== 'undefined',
        };
      });

    const q = (opts?.q || '').trim().toLowerCase();
    const category = (opts?.category || '').trim();
    if (q) {
      entries = entries.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        String((c as any).description || '').toLowerCase().includes(q),
      );
    }
    if (category) entries = entries.filter(c => c.category === category);
    if (opts?.enabled !== undefined) entries = entries.filter(c => c.enabled === opts.enabled);

    // Sort by popularity (well-known services first)
    const POP: Record<string, number> = {
      'gmail': 100, 'outlook': 99, 'slack': 99, 'github': 99, 'discord': 98,
      'google-calendar': 98, 'notion': 98, 'google-drive': 97, 'microsoft-365': 97,
      'telegram': 97, 'whatsapp': 96, 'google-sheets': 96, 'onedrive': 95,
      'gitlab': 95, 'airtable': 95, 'google-docs': 95, 'google-slides': 94,
      'microsoft-teams': 94, 'trello': 93, 'asana': 94, 'jira': 94, 'docker': 93,
      'stripe': 89, 'paypal': 88, 'shopify': 87, 'salesforce': 88, 'hubspot': 87,
      'twitter': 89, 'facebook': 88, 'instagram': 87, 'linkedin': 86, 'youtube': 88,
      'aws': 89, 'azure': 87, 'gcp': 88, 'cloudflare': 86, 'supabase': 86,
      'firebase': 87, 'mongodb': 85, 'figma': 87, 'canva': 85, 'zoom': 88,
      'calendly': 86, 'spotify': 88, 'zapier': 88, 'make': 86, 'n8n': 84,
      'sentry': 85, 'datadog': 84, 'twilio': 86, 'sendgrid': 85, 'dropbox': 86,
      'adobe': 84, 'airbnb': 85, 'uber': 86, 'netflix': 85,
    };
    entries.sort((a, b) => {
      const pa = POP[a.id] ?? POP[a.credentialKey ?? ''] ?? 0;
      const pb = POP[b.id] ?? POP[b.credentialKey ?? ''] ?? 0;
      return pb - pa || a.name.localeCompare(b.name);
    });

    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : entries.length;
    const page = entries.slice(offset, offset + limit);
    const categories = [...new Set(entries.map(c => c.category))].sort();
    return {
      count: entries.length,
      total: entries.length,
      active,
      offset,
      limit,
      categories,
      entries: page,
    };
  }

  async connectMcp(id: string, opts: { baseUrl?: string; apiKey?: string; enabled?: boolean }): Promise<any> {
    const entry = await this.configManager.upsertMcpConnector(id, {
      baseUrl: opts.baseUrl,
      enabled: opts.enabled,
    });
    if (opts.apiKey) {
      // Mirror the key under the catalog id and any curated credential_service
      // too, so curated tools (which look up `credential_service`) find it.
      const keys = new Set<string>([entry.credentialKey || entry.name, entry.id]);
      const curatedService = curatedConnectorForCatalogId(entry.id)?.credentialService;
      if (curatedService) keys.add(curatedService);

      for (const k of keys) {
        // ConnectorStore — what ToolExecutor.resolveAuth reads.
        this.connectorApi?.saveOAuthTokens({
          userId: 'default', connectorId: k, apiKey: opts.apiKey,
          accessToken: opts.apiKey, expiresIn: 0,
        });
        if (this.credVault.isUnlocked) {
          const existing = this.credVault.find(k);
          this.credVault.set({ service: k, username: 'api-key', secret: opts.apiKey }, existing?.id);
        }
      }
      if (!this.credVault.isUnlocked) {
        getLogger().warn({ id }, 'Vault locked — API key not mirrored to vault');
      }
    } else if (opts.baseUrl && opts.enabled && entry.authType !== 'none') {
      const cred = this.credVault.find(entry.credentialKey || entry.name);
      if (!cred) {
        getLogger().warn({ id }, 'Connector enabled without stored secret — authType expects one');
      }
    }
    // Re-register in the live registry so the router can dispatch immediately.
    if (opts.enabled && entry.baseUrl) {
      this.mcpRegistry.register(entry.id, entry.tool || 'invoke', {
        endpoint: entry.baseUrl,
        credentialService: entry.credentialKey || entry.name,
        apiKeyHeader: entry.apiKeyHeader,
        authType: entry.authType,
      });
    }
    return { connector: entry, registered: opts.enabled && Boolean(entry.baseUrl) };
  }

  async syncExternalConnectors(opts?: { maxPerSource?: number }): Promise<any> {
    const result = await this.mcpExternal.sync({ maxPerSource: opts?.maxPerSource ?? 100 });
    return result;
  }

  /**
   * Bulk-import connectors from every bundled registry (Smithery + the
   * official MCP registry — thousands of streamable-HTTP servers). Each
   * remote server registers as a callable connector through the same MCP
   * router; missing credentials are resolved lazily from the vault.
   */
  async syncExternalMcpSources(opts?: { maxPerSource?: number }): Promise<any> {
    const result = await this.mcpExternal.sync({
      maxPerSource: opts?.maxPerSource ?? 0, // 0 = import everything the registries publish
      sources: DEFAULT_SOURCES,
    });
    return result;
  }

  /** Disable a connector: persist enabled:false and drop its live binding. */
  async disconnectMcp(id: string): Promise<any> {
    const entry = await this.configManager.upsertMcpConnector(id, { enabled: false });
    this.mcpRegistry.remove(entry.id, entry.tool || 'invoke');
    getLogger().info({ id }, 'MCP connector disconnected');
    return { connector: entry, connected: false };
  }

  // ── OAuth connector flow (Gmail, Microsoft 365, Dropbox, …) ──

  private oauthRedirectUri(): string {
    return `${this.publicBaseUrl()}/api/mcp/oauth/callback`;
  }

  /** The catalog's credentialKey (e.g. 'gmail'), used to look up the OAuth client. */
  private oauthKeyFor(id: string): string {
    const entry = MCP_CATALOG.find(c => c.id === id);
    return entry?.credentialKey || id;
  }

  /**
   * Resolve the OAuth client for a connector, checking BOTH credential stores:
   *   1. ConfigManager.mcp.oauthClients — file-based, operator-edited
   *   2. ConnectorStore.developer_credentials — SQLite, written by the UI
   *      (/api/connectors/credential) and /api/admin/credentials
   * Previously only the first was read, so credentials saved through the UI
   * were invisible here and the setup modal looped forever.
   */
  private oauthClientFor(id: string): { key: string; client: McpOauthClientConfig } {
    const key = this.oauthKeyFor(id);

    const configured = this.configManager.getMcpOauthClient(key);
    if (configured?.clientId) return { key, client: configured };

    const stored = this.connectorApi?.getDeveloperCredentials(key);
    if (stored?.isConfigured && stored.clientId) {
      return {
        key,
        client: {
          clientId: stored.clientId,
          clientSecret: stored.clientSecret || undefined,
          scopes: stored.scopes?.length ? stored.scopes : undefined,
        },
      };
    }

    throw new Error(
      `OAuth client not configured for "${key}" — register the app with the provider, then add mcp.oauthClients["${key}"] = { clientId }`,
    );
  }

  /** Start OAuth for an `oauth` connector: returns the authorize URL to open. */
  async beginMcpOauth(id: string, redirectUri?: string): Promise<any> {
    const entry = await this.configManager.upsertMcpConnector(id, {});
    if (entry.authType !== 'oauth') throw new Error(`Connector "${id}" is not OAuth (authType=${entry.authType})`);
    const { key, client } = this.oauthClientFor(id);
    // Resolve the provider against the CREDENTIAL KEY, not the catalog id:
    // the provider table is keyed `gmail`, while the catalog id is
    // `productivity-gmail`. Passing `id` here made every catalog connector
    // fail to resolve.
    const started = this.oauth.begin(key, client, redirectUri || this.oauthRedirectUri());
    return {
      connector: entry,
      key,
      connectorId: id,
      authorizeUrl: started.authorizeUrl,
      state: started.state,
    };
  }

  /**
   * Complete OAuth: exchange the code, persist tokens, and enable the connector.
   *
   * `key` coming back from the pending flow is the CREDENTIAL KEY (e.g.
   * `gmail`), so it must be mapped back to the catalog id (`productivity-gmail`)
   * before touching config. Several catalog entries can share one credentialKey
   * (Google Calendar/Drive/Sheets all use `google-*`), so we prefer the
   * connector whose pending flow actually produced this state when possible.
   */
  async completeMcpOauth(code: string, state: string): Promise<any> {
    const { key, tokens } = await this.oauth.complete(code, state);
    const id = this.catalogIdForCredentialKey(key);
    const entry = await this.configManager.upsertMcpConnector(id, {});
    if (entry.authType !== 'oauth') throw new Error(`Connector "${id}" is not OAuth (authType=${entry.authType})`);

    this.storeOauthToken(this.oauthKeyFor(id), tokens, id);

    // Enable + register the live binding now that credentials exist.
    await this.configManager.upsertMcpConnector(id, { enabled: true });
    this.registerConnectorBinding(entry);
    return { connector: entry, key, connectorId: id, connected: true, expiresAt: tokens.expiresAt };
  }

  /** Map a credentialKey back to its catalog connector id. */
  private catalogIdForCredentialKey(key: string): string {
    const existing = this.configManager.raw.mcp.connectors.find(
      c => (c.credentialKey || c.id) === key && c.authType === 'oauth',
    );
    if (existing) return existing.id;
    const entry = MCP_CATALOG.find(c => (c.credentialKey || c.id) === key);
    return entry?.id ?? key;
  }

  /**
   * Persist an OAuth token set.
   *
   * Tokens are written to BOTH stores because two consumers read them:
   *   - ConnectorStore.user_connections — what ToolExecutor reads per request
   *     (and what its auto-refresh path updates), keyed by CATALOG id.
   *   - CredentialVault `oauth:<key>` — the raw token set incl. expiry.
   *
   * The vault entry is stored with username `api-key` and the BARE access token
   * as the secret. Previously it held a JSON blob under username `oauth-token`,
   * which McpHttpConnector.authHeaders() interpreted as a user/password pair
   * and base64-encoded into a `Basic` header — every OAuth call sent a garbage
   * credential. A bearer-shaped entry is correct for both consumers.
   */
  private storeOauthToken(key: string, tokens: OAuthTokenSet, catalogId?: string): void {
    const connectorId = catalogId ?? this.catalogIdForCredentialKey(key);
    const expiresIn = Math.max(0, Math.floor((tokens.expiresAt - Date.now()) / 1000));

    // 1. ConnectorStore — the executor's source of truth.
    //
    // The same token is written under EVERY key a call path might look it up
    // by, because those keys disagree today:
    //   - `productivity-gmail`  the catalog id (what the UI and /status use)
    //   - `gmail`               the credentialKey
    //   - `google`               curated tools' shared credential_service
    //     (Calendar/Drive/Sheets all declare `google`, not their own key)
    // Storing under only one left curated tools reporting "not connected"
    // even after a successful authorization.
    const storeKeys = new Set<string>([connectorId, key]);
    const curatedService = curatedConnectorForCatalogId(connectorId)?.credentialService;
    if (curatedService) storeKeys.add(curatedService);

    for (const storeKey of storeKeys) {
      this.connectorApi?.saveOAuthTokens({
        userId: 'default',
        connectorId: storeKey,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn,
      });
    }

    // 2. CredentialVault — bearer-shaped so McpHttpConnector can use it.
    // Mirrored under the same set of keys for the same reason.
    if (!this.credVault.isUnlocked) {
      getLogger().warn({ key }, 'Vault locked — OAuth token not mirrored to vault');
      return;
    }
    for (const storeKey of storeKeys) {
      const existing = this.credVault.find(storeKey);
      this.credVault.set(
        { service: storeKey, username: 'api-key', secret: tokens.accessToken },
        existing?.id,
      );
    }
  }

  /**
   * Read the stored OAuth token set. ConnectorStore is consulted first (it
   * holds the refresh token and expiry that the executor maintains); the vault
   * is the fallback for tokens written before this dual-write existed.
   */
  private readOauthToken(key: string): OAuthTokenSet | undefined {
    const connectorId = this.catalogIdForCredentialKey(key);

    // Try every key the token may have been stored under (see storeOauthToken).
    const candidates = [connectorId, key];
    const curatedService = curatedConnectorForCatalogId(connectorId)?.credentialService;
    if (curatedService) candidates.push(curatedService);

    for (const candidate of candidates) {
      const stored = this.connectorApi?.getOAuthTokens('default', candidate);
      if (stored?.accessToken) {
        const conn = this.connectorApi?.getConnectionRow('default', candidate);
        return {
          accessToken: stored.accessToken,
          refreshToken: stored.refreshToken,
          expiresAt: conn?.tokenExpiresAt?.getTime() ?? Date.now() + 3600_000,
        };
      }
    }

    if (!this.credVault.isUnlocked) return undefined;
    for (const candidate of candidates) {
      const entry = this.credVault.find(candidate);
      if (!entry) continue;
      // Legacy shape: a JSON token blob.
      try {
        const parsed = JSON.parse(entry.secret) as OAuthTokenSet;
        if (parsed?.accessToken) return parsed;
      } catch { /* not JSON — it's the bare bearer token */ }
      return { accessToken: entry.secret, expiresAt: Date.now() + 3600_000 };
    }
    return undefined;
  }

  /** Live registry binding for a connector (same shape as connectMcp). */
  private registerConnectorBinding(entry: McpConnectorConfig): void {
    if (entry.baseUrl) {
      this.mcpRegistry.register(entry.id, entry.tool || 'invoke', {
        endpoint: entry.baseUrl,
        credentialService: entry.credentialKey || entry.name,
        apiKeyHeader: entry.apiKeyHeader,
        authType: entry.authType,
      });
    }
  }

  /** Report connection state for an OAuth connector (tokens never exposed). */
  getMcpOauthStatus(id: string): Record<string, unknown> {
    const key = this.oauthKeyFor(id);
    const tokens = this.readOauthToken(key);
    if (!tokens) return { connected: false };
    return {
      connected: true,
      expiresAt: tokens.expiresAt,
      expired: tokens.expiresAt <= Date.now(),
      hasRefreshToken: Boolean(tokens.refreshToken),
    };
  }

  /** Refresh an expiring OAuth token (and persist the new set). */
  async refreshMcpOauth(id: string): Promise<any> {
    const { key, client } = this.oauthClientFor(id);
    const tokens = this.readOauthToken(key);
    if (!tokens?.refreshToken) throw new Error('No refresh token stored for this connector');
    const resolved = this.oauth.resolve(key, client);
    const next = await this.oauth.refresh(client, resolved.provider, tokens.refreshToken);
    this.storeOauthToken(key, { ...tokens, ...next });
    return { connected: true, expiresAt: next.expiresAt };
  }

  /** Persist a refreshed token set (used by the executor's auto-refresh). */
  async persistRefreshedOauth(id: string, tokens: OAuthTokenSet): Promise<void> {
    this.storeOauthToken(this.oauthKeyFor(id), tokens, id);
  }

  // ── Model routing / plans / BYOK ───────────────────────────

  /** Plan + usage dashboard: spend by slot, budget remaining, metering. */
  async getPlanUsage(tenantId?: string): Promise<any> {
    const snap = tenantId ? this.tenants.status(tenantId).usage! : this.modelRouter.snapshot();
    return {
      ...(tenantId ? { tenant: tenantId } : {}),
      plan: snap.plan,
      planName: snap.planName,
      monthlyPriceUsd: snap.monthlyPriceUsd,
      budget: {
        monthlyBudgetUsd: snap.monthlyBudgetUsd,
        spentUsd: snap.spentUsd,
        remainingUsd: snap.remainingUsd,
        slotBudgets: snap.slotBudgets,
        spentBySlot: snap.spentBySlot,
      },
      routing: {
        enabled: snap.enabled,
        optimizations: snap.optimizations,
        maxOutputTokens: snap.maxOutputTokens,
      },
      plans: snap.plans,
      metering: this.metering.snapshot(),
    };
  }

  // ── LLM boot health ──────────────────────────────────────────────

  /** Endpoint the active provider is expected to answer on. */
  private llmEndpoint(provider: string): string {
    const c = this.configManager.raw;
    switch (provider) {
      case 'ollama': return String(c.ollama?.endpoint || 'http://localhost:11434').replace(/\/+$/, '');
      case 'openai-compatible': return String(c.openaiCompatible?.endpoint || '').replace(/\/+$/, '');
      case 'openai': return String(c.openai?.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
      case 'anthropic': return 'https://api.anthropic.com/v1';
      default: return '';
    }
  }

  /** Cheap liveness URL for the active provider (null = not probeable). */
  private llmProbeUrl(provider: string, endpoint: string): string | null {
    if (!endpoint) return null;
    if (provider === 'ollama') return `${endpoint}/api/tags`;
    if (provider === 'openai-compatible' || provider === 'openai') return `${endpoint}/models`;
    return null;
  }

  /** Human-readable reason the provider cannot be used, or undefined. */
  private llmMissingCredential(provider: string): string | undefined {
    const c = this.configManager.raw;
    if (provider === 'openai-compatible') {
      if (!c.openaiCompatible?.endpoint) {
        return 'openai-compatible provider selected but no endpoint configured (openaiCompatible.endpoint) — set UMBRA_LLM_PROVIDER back to a local provider or configure it in Settings → Provider';
      }
      if (!c.openaiCompatible?.apiKey) {
        return 'openai-compatible provider selected but no API key configured (openaiCompatible.apiKey) — set it in Settings → Provider';
      }
      return undefined;
    }
    if (provider === 'openai' && !c.openai?.apiKey) {
      return 'OpenAI provider selected but no API key configured (openai.apiKey) — set it in Settings → Provider';
    }
    if (provider === 'anthropic' && !c.anthropic?.apiKey) {
      return 'Anthropic provider selected but no API key configured (anthropic.apiKey) — set it in Settings → Provider';
    }
    return undefined;
  }

  /**
   * One-shot startup probe of the configured LLM endpoint. Never throws and
   * never blocks boot for more than ~2s: an unreachable provider downgrades
   * Umbra to an explicit "LLM disabled" state with an actionable message
   * (reported via /api/status → `llm`), instead of every AI task failing
   * with an opaque connect error — or the process dying.
   */
  private async checkLlmHealth(): Promise<void> {
    const c = this.configManager.raw;
    const checkedAt = Date.now();
    const pre = c.llm || { disabled: false };

    if (pre.disabled) {
      const reason = pre.reason || 'LLM disabled by configuration (UMBRA_LLM_PROVIDER=none)';
      this.llmHealth = {
        provider: pre.provider || c.provider,
        endpoint: '',
        reachable: false,
        disabled: true,
        error: reason,
        message: reason,
        checkedAt,
      };
      getLogger().warn({ reason }, 'LLM disabled at boot — AI tasks will report SERVICE_DISABLED (Umbra keeps running)');
      return;
    }

    const provider = c.provider;
    const endpoint = this.llmEndpoint(provider);
    const probeUrl = this.llmProbeUrl(provider, endpoint);
    const missing = this.llmMissingCredential(provider);

    if (missing) {
      this.llmHealth = { provider, endpoint, reachable: false, disabled: true, error: missing, message: missing, checkedAt };
      getLogger().warn({ provider }, `LLM unavailable — ${missing}`);
      return;
    }
    if (!probeUrl) {
      // Nothing cheap to probe (authenticated-only provider): assume healthy
      // and let the circuit breaker decide on the first real call.
      this.llmHealth = {
        provider,
        endpoint,
        reachable: true,
        disabled: false,
        message: 'No startup probe available for this provider — verified on first call',
        checkedAt,
      };
      getLogger().info({ provider, endpoint }, 'LLM provider configured (no startup probe)');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(probeUrl, { method: 'GET', signal: controller.signal });
      // 401/404 still proves something is listening; only 5xx means unusable.
      if (res.status < 500) {
        this.llmHealth = {
          provider, endpoint, reachable: true, disabled: false,
          message: `Provider reachable (HTTP ${res.status})`, checkedAt,
        };
        getLogger().info({ provider, endpoint, status: res.status }, 'LLM provider reachable');
      } else {
        const reason = `LLM provider at ${endpoint} returned HTTP ${res.status}`;
        this.llmHealth = { provider, endpoint, reachable: false, disabled: true, error: reason, message: reason, checkedAt };
        getLogger().warn({ provider, endpoint, status: res.status }, reason);
      }
    } catch (err: any) {
      const reason = `LLM provider unreachable at ${endpoint} (${err?.name === 'AbortError' ? 'timeout after 2s' : err?.message || 'connection refused'}) — start it, or point Umbra at another provider (UMBRA_LLM_PROVIDER=ollama|openai-compatible|none)`;
      this.llmHealth = { provider, endpoint, reachable: false, disabled: true, error: reason, message: reason, checkedAt };
      getLogger().warn({ provider, endpoint, err: err?.message }, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  async getModelStatus(): Promise<any> {
    const snap = this.modelRouter.snapshot();
    return {
      provider: this.configManager.raw.provider,
      health: this.llmHealth,
      models: this.configManager.raw.models,
      plan: snap.plan,
      planName: snap.planName,
      monthlyPriceUsd: snap.monthlyPriceUsd,
      budget: {
        monthlyBudgetUsd: snap.monthlyBudgetUsd,
        spentUsd: snap.spentUsd,
        remainingUsd: snap.remainingUsd,
        slotBudgets: snap.slotBudgets,
        spentBySlot: snap.spentBySlot,
      },
      routing: {
        enabled: snap.enabled,
        optimizations: snap.optimizations,
        maxOutputTokens: snap.maxOutputTokens,
        tiers: snap.tiers,
      },
      plans: snap.plans,
      metering: this.metering.snapshot(),
    };
  }

  /** Make a tiny live completion to validate the configured provider/key. */
  async testLlm(): Promise<any> {
    // Unreachable/disabled provider (see checkLlmHealth): report the reason and
    // how to fix it instead of surfacing a raw connect error.
    if (this.llmHealth.disabled) {
      return {
        ok: false,
        provider: this.llmHealth.provider,
        endpoint: this.llmHealth.endpoint,
        error: this.llmHealth.error || 'LLM provider unavailable',
        message: this.llmHealth.message || this.llmHealth.error,
        hint: 'Start the provider (e.g. `ollama serve`) or switch it in Settings → Provider',
        health: this.llmHealth,
      };
    }
    const started = Date.now();
    try {
      const res = await this.llm.complete(
        [{ role: 'user', content: 'Reply with the single word: ok' }],
        'fast',
        { maxTokens: 8, temperature: 0 },
      );
      return {
        ok: true,
        model: res.modelUsed,
        tokens: res.totalTokens,
        latencyMs: Date.now() - started,
        content: res.content.slice(0, 200),
      };
    } catch (err: any) {
      // Re-probe so a provider that died after boot is reported as disabled.
      await this.checkLlmHealth();
      return {
        ok: false,
        provider: this.llmHealth.provider || this.configManager.raw.provider,
        error: err?.message || 'LLM call failed',
        message: this.llmHealth.message || err?.message || 'LLM call failed',
        health: this.llmHealth,
      };
    }
  }

  /**
   * Activate a paid plan after payment succeeds. This is the hook a billing
   * provider (Stripe / LemonSqueezy webhook or manual admin call) triggers
   * once a user pays — it flips the tier, enables routing + the token-saving
   * stack, and the monthly token budget (pre-split per model slot) is
   * applied automatically from the plan profile.
   *
   * Budget breakdown:
   *   - Pro:        $19.99/mo — $5 models, $6 cloud VPS
   *   - Advanced:   $38/mo    — $10 models, $8 cloud VPS
   *   - Enterprise: $89.99/mo — $20 models, $25 cloud VPS, $15 telco
   */
  async activatePlan(tier: string, tenantId?: string): Promise<any> {
    const allowed: PlanTier[] = ['free', 'byok', 'pro', 'ultimate', 'enterprise'];
    const t = tier as PlanTier;
    if (!allowed.includes(t)) throw new Error(`Unknown plan: ${tier}`);

    // Per-tenant activation: only this tenant's router changes; the node's
    // own plan (and every other tenant) is untouched. Tenant must already be
    // registered (POST /api/tenants/register).
    if (tenantId) {
      const status = this.tenants.activate(tenantId, t);
      const usage = status.usage!;
      getLogger().info({ tenant: tenantId, tier: t }, 'Tenant plan activated — per-tenant token budget assigned');
      return {
        tenant: tenantId,
        plan: t,
        planName: status.name || usage.planName,
        budget: {
          monthlyBudgetUsd: usage.monthlyBudgetUsd,
          spentUsd: usage.spentUsd,
          remainingUsd: usage.remainingUsd,
          slotBudgets: usage.slotBudgets,
          spentBySlot: usage.spentBySlot,
        },
        routing: { enabled: usage.enabled, optimizations: usage.optimizations, maxOutputTokens: usage.maxOutputTokens },
        deviceLimit: status.deviceLimitLabel,
      };
    }

    const cm = this.configManager;
    cm.raw.plan.tier = t;

    // Hosted plans turn on routing + the full token-saving stack.
    if (t === 'pro' || t === 'ultimate' || t === 'enterprise') {
      cm.raw.plan.routing = cm.raw.plan.routing ?? { ...DEFAULT_ROUTING };
      cm.raw.plan.routing.enabled = true;
      cm.raw.plan.routing.graphify = true;
      cm.raw.plan.routing.caveman = true;
      cm.raw.plan.routing.cacheHitRatio = cm.raw.plan.routing.cacheHitRatio || DEFAULT_ROUTING.cacheHitRatio;
    }
    // Cloud continuation (resuming in-flight tasks on the cloud node) is a
    // paid feature: paid tiers get it, free does not.
    cm.raw.plan.cloudContinuation = t !== 'free';
    await cm.saveConfig();

    this.metering.setTier(t);
    const config = cm.raw;
    this.llm.updateConfig(config);
    this.modelRouter.updateConfig(config);

    getLogger().info({ tier: t }, 'Plan activated — token budget assigned');
    return this.getModelStatus();
  }

  /** Bring-your-own-key: point Umbra at the user's provider + keys/models. */
  async configureProvider(patch: {
    provider?: string;
    endpoint?: string;
    apiKey?: string;
    models?: { reasoning?: string; vision?: string; fast?: string; embedding?: string };
    tier?: string;
  }): Promise<any> {
    const cm = this.configManager;
    if (patch.provider) {
      await cm.updateProvider(patch.provider as ModelProvider, {
        reasoning: patch.models?.reasoning,
        vision: patch.models?.vision,
        fast: patch.models?.fast,
        embedding: patch.models?.embedding,
      });
    }
    if (patch.endpoint || patch.apiKey) {
      const provider = (patch.provider || cm.raw.provider) as ModelProvider;
      const creds: { endpoint?: string; apiKey?: string } = {};
      if (patch.endpoint !== undefined) creds.endpoint = patch.endpoint;
      if (patch.apiKey !== undefined) creds.apiKey = patch.apiKey;
      await cm.updateProviderCredentials(provider, creds);
    }
    if (patch.tier) {
      cm.raw.plan.tier = patch.tier as PlanTier;
      await cm.saveConfig();
      this.metering.setTier(patch.tier as PlanTier);
    }
    const config = cm.raw;
    this.llm.updateConfig(config);
    this.modelRouter.updateConfig(config);
    // Re-probe: the user just switched provider/keys — refresh the boot health
    // so /api/status stops advertising the previous provider as disabled.
    config.llm = { ...config.llm, disabled: false };
    await this.checkLlmHealth();
    return this.getProviderConfig();
  }

  async getProviderConfig(): Promise<any> {
    const c = this.configManager.raw;
    const mask = (k?: string) => (k ? (k.length <= 8 ? '••••' : `••••${k.slice(-4)}`) : undefined);
    return {
      provider: c.provider,
      models: c.models,
      endpoints: {
        ollama: c.ollama?.endpoint,
        openai: c.openai?.endpoint,
        anthropic: 'https://api.anthropic.com/v1/messages',
        openaiCompatible: c.openaiCompatible?.endpoint,
      },
      keys: {
        openai: mask(c.openai?.apiKey),
        anthropic: mask(c.anthropic?.apiKey),
        openaiCompatible: mask(c.openaiCompatible?.apiKey),
      },
      plan: c.plan.tier,
    };
  }

  // ── JIT Infrastructure: Stripe Webhook + Wallet + Smart Routing ──

  /**
   * JIT Stripe webhook — spec compliant.
   * POST /api/stripe-webhook expects rawBody + stripe-signature header.
   * Uses `stripe.webhooks.constructEvent` with STRIPE_WEBHOOK_SECRET.
   * Handles checkout.session.completed → PRO ($19.99) / ADVANCED ($38) / ENTERPRISE ($89.99)
   * and customer.subscription.deleted → Hetzner teardown.
   */
  async handleStripeWebhookJIT(rawBody: string, signature: string): Promise<any> {
    const secret = this.configManager.raw.billing.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    let event: any;
    if (this.stripeClient) {
      try {
        event = this.stripeClient.webhooks.constructEvent(rawBody, signature, secret);
      } catch (e: any) {
        throw new Error(`Invalid Stripe signature: ${e.message}`);
      }
    } else {
      // Fallback manual verify via StripeBilling helper
      const ok = (this.billing as any)?.verifySignature?.call(this.billing, rawBody, signature);
      if (!ok) throw new Error('Invalid Stripe webhook signature');
      event = JSON.parse(rawBody);
    }

    const type = event.type;
    if (type === 'checkout.session.completed') {
      const session = event.data.object;
      // Identify plan by Price ID or metadata.tier
      const priceId = session?.line_items?.data?.[0]?.price?.id || session?.display_items?.[0]?.price?.id || session?.metadata?.price_id || '';
      const metaTier = String(session?.metadata?.tier || session?.metadata?.plan || '').toLowerCase();
      const priceMap = this.configManager.raw.billing.priceIds || {};
      let tier: 'pro' | 'advanced' | 'enterprise' = 'pro';
      if (priceId && priceId === priceMap.pro) tier = 'pro';
      else if (priceId && (priceId === priceMap.ultimate || priceId === (priceMap as any).advanced)) tier = 'advanced';
      else if (priceId && priceId === priceMap.enterprise) tier = 'enterprise';
      else if (metaTier.includes('enterprise')) tier = 'enterprise';
      else if (metaTier.includes('advanced') || metaTier.includes('ultimate')) tier = 'advanced';
      else if (metaTier.includes('pro')) tier = 'pro';
      else {
        // fallback: amount_total heuristic ($19.99 / $38 / $89.99)
        const amount = session?.amount_total ?? session?.amount_subtotal ?? 0;
        if (amount >= 8000) tier = 'enterprise';      // $80+ cutoff
        else if (amount >= 3000) tier = 'advanced';   // $30+ cutoff
        else tier = 'pro';
      }

      const email = session?.customer_details?.email || session?.customer_email || '';
      const customerId = String(session?.customer || '');
      const subscriptionId = String(session?.subscription || '');
      // Find or create user: try tenant metadata, then email
      let userId: string | null = String(session?.metadata?.tenant || session?.client_reference_id || '').trim() || null;
      let user = userId ? this.userStore!.getUserById(userId) : null;
      if (!user && email) {
        // try find by email (case-insensitive)
        const row = (this.userStore as any).db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(email) as any;
        if (row) user = this.userStore!.getUserById(row.id);
        if (!user) {
          // auto-create lightweight user for JIT
          const created = this.userStore!.signup(email, crypto.randomUUID(), email.split('@')[0]);
          user = created;
          userId = created ? created.id : null;
        } else userId = user.id;
      }
      if (!userId || !user) throw new Error('No user could be resolved for checkout session');
      if (customerId) this.virtualWallet!.linkStripe(userId, customerId, subscriptionId);

      // Activate plan + wallet (budgets: Pro=5, Advanced=10, Enterprise=30 models)
      const budgets = this.virtualWallet!.getBudgets(tier);
      this.virtualWallet!.init(userId, tier);
      const activateTier = tier === 'advanced' ? 'ultimate' : tier;
      await this.activatePlan(activateTier, userId);

      // JIT Hetzner VPS provisioning
      if (this.hetznerProvisioner?.enabled) {
        getLogger().info({ userId, tier, customerId }, 'JIT provisioning Hetzner');
        const result = await this.hetznerProvisioner.provision(userId, tier);
        if (result.serverId) {
          this.virtualWallet!.linkServer(userId, result.serverId);
          getLogger().info({ userId, tier, serverId: result.serverId, ip: result.ip, cost: result.estimatedCost }, 'JIT Hetzner server created');
          return { event: type, tier, userId, serverId: result.serverId, ip: result.ip, budgets, provisioned: true };
        }
        return { event: type, tier, userId, budgets, provisioned: false, error: result.error };
      }
      return { event: type, tier, userId, budgets, provisioned: false, hetznerDisabled: true };
    }

    if (type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = String(sub.customer || sub.customerId || '');
      let user = customerId ? this.userStore!.findByStripeCustomerId(customerId) : null;
      let serverId: number | null = null;
      if (user) serverId = this.userStore!.getHetznerServerId(user.id);
      if (serverId && this.hetznerProvisioner?.enabled) {
        await this.hetznerProvisioner.teardown(serverId);
        getLogger().info({ serverId, customerId, userId: user?.id }, 'JIT Hetzner server destroyed on subscription.deleted');
        return { event: type, customerId, serverId, tornDown: true };
      }
      // fallback fuzzy
      if (this.hetznerProvisioner?.enabled) {
        const servers = await this.hetznerProvisioner.listUmbraServers();
        for (const s of servers) {
          if (customerId && s.name.includes(customerId.slice(0, 8))) {
            await this.hetznerProvisioner.teardown(s.id);
            getLogger().info({ serverId: s.id, customerId }, 'JIT VPS torn down on subscription.deleted (fallback)');
            return { event: type, customerId, serverId: s.id, tornDown: true };
          }
        }
      }
      return { event: type, customerId, tornDown: false, reason: 'no serverId linked' };
    }

    getLogger().info({ type }, 'Stripe webhook ignored (unhandled type)');
    return { event: type, ignored: true };
  }

  /** Smart routing with wallet + tier awareness and sticky prompt caching. */
  getSmartRoute(userId: string, taskType: 'vision_ocr' | 'reasoning' | 'coding_heavy' | 'coding_fast' | 'routine' | 'backend_heavy' | 'agentic_code', preferAltVision?: boolean): any {
    const user = this.userStore!.getUserById(userId);
    // Canonical tier spelling via pricing.ts: ultimate/advanced fold together,
    // enterprise keeps its full-model route table.
    const rawPlan = (user?.plan as any) || 'free';
    const plan = normalizeRoutePlan(rawPlan) ?? rawPlan;
    const depleted = userId ? this.virtualWallet!.depleted(userId) : false;
    const decision = this.smartRouter.route(plan as any, taskType, { walletDepleted: depleted, preferAltVision });
    // Which ModelRouter budget slot pays for this decision (TASK_TO_SLOT bridge).
    const slot = TASK_TO_SLOT[taskType] ?? 'fast';
    return { ...decision, plan, slot, wallet: userId ? this.virtualWallet!.balance(userId) : null, depleted };
  }

  deductWalletForUsage(userId: string, model: string, usage: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; prompt_tokens_details?: any }): number {
    const cost = this.smartRouter.calculateCost(model, usage as any);
    const remaining = this.virtualWallet!.deduct(userId, cost);
    getLogger().info({ userId, model, cost, remaining, cached: (usage as any).cached_tokens ?? (usage as any).prompt_tokens_details?.cached_tokens }, 'Wallet deducted (incl. cache_read)');
    return remaining;
  }

  getWalletBalance(userId: string): number {
    return this.virtualWallet!.balance(userId);
  }

  /**
   * Smart OpenRouter call — prompt structure identical across loops for caching.
   * Wraps fetch to https://openrouter.ai/api/v1/chat/completions with sticky prefix.
   */
  async smartOpenRouterComplete(userId: string, messages: any[], taskType: 'vision_ocr' | 'reasoning' | 'coding_heavy' | 'coding_fast' | 'routine' | 'backend_heavy' | 'agentic_code', opts: { preferAltVision?: boolean; maxTokens?: number } = {}): Promise<any> {
    const route = this.getSmartRoute(userId, taskType, opts.preferAltVision);
    const model = route.model;
    const apiKey = (this.configManager.raw as any).openrouterApiKey || this.configManager.raw.openaiCompatible?.apiKey || process.env.OPENROUTER_API_KEY || '';
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');
    // Sticky prompt: keep system prefix identical across loops for cache hits
    const stickyMessages = messages.map((m: any) => m.role === 'system' ? { ...m, content: buildStickySystemPrompt(m.content) } : m);

    const res = await HttpBridge.post('https://openrouter.ai/api/v1/chat/completions', { model, messages: stickyMessages, max_tokens: opts.maxTokens }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': this.configManager.raw.billing.publicUrl || 'https://umbra.os', 'X-Title': 'Umbra OS' });
    const json: any = res.data;
    const usage = json.usage || {};
    // Financial safety ceiling: deduct exact cost incl. cache_read
    try { this.deductWalletForUsage(userId, model, usage); } catch {}
    // If depleted, next call will be forced to free via getSmartRoute
    return { ...json, routedModel: model, routeReason: route.reason };
  }

  /** Configure Telnyx SMS/call: store the API token in the vault, persist the
   *  sender number + messaging profile, and rebuild the live client. */
  async configureTelco(patch: {
    apiKey?: string;
    fromNumber?: string;
    messagingProfileId?: string;
    enabled?: boolean;
  }): Promise<any> {
    if (patch.apiKey) {
      if (this.credVault.isUnlocked) {
        const existing = this.credVault.find('telnyx');
        this.credVault.set({ service: 'telnyx', username: 'api-key', secret: patch.apiKey }, existing?.id);
      } else {
        getLogger().warn('Credential vault locked — Telnyx API token not stored');
      }
    }
    await this.configManager.updateTelco({
      enabled: patch.enabled,
      fromNumber: patch.fromNumber,
      messagingProfileId: patch.messagingProfileId,
    });
    this.telnyx = new TelnyxClient({
      fromNumber: this.configManager.raw.telco.fromNumber,
      messagingProfileId: this.configManager.raw.telco.messagingProfileId,
      vault: this.credVault,
    });
    getLogger().info({ fromNumber: this.configManager.raw.telco.fromNumber }, 'Telco configured');
    return this.getTelcoStatus();
  }

  async getTelcoStatus(): Promise<any> {
    const c = this.configManager.raw.telco;
    return {
      enabled: c.enabled,
      provider: c.provider,
      fromNumber: c.fromNumber,
      messagingProfileId: c.messagingProfileId,
      tokenConfigured: !!this.telnyx?.resolvedToken,
    };
  }

  /** Export the durable task queue (filename → JSON text) for cross-node sync. */
  exportTaskQueue(): { files: Record<string, string> } {
    const dir = this.taskStore.storeDir;
    const files: Record<string, string> = {};
    try {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.json') && !f.endsWith('.tmp')) {
            files[f] = fs.readFileSync(path.join(dir, f), 'utf-8');
          }
        }
      }
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Task queue export failed');
    }
    return { files };
  }

  /** Import task-queue files from another node, then resume unfinished work. */
  async importTaskQueue(payload: { files?: Record<string, string> }): Promise<{ imported: number; resumed: number }> {
    const dir = this.taskStore.storeDir;
    fs.mkdirSync(dir, { recursive: true });
    let imported = 0;
    for (const [name, content] of Object.entries(payload.files ?? {})) {
      // Only accept safe, top-level JSON filenames (no traversal, no junk).
      if (path.basename(name) !== name || !name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const target = path.join(dir, name);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, target);
      imported++;
    }
    const resumed = await this.agent.resumePendingTasks(this.role, this.configManager.raw.plan.tier);
    getLogger().info({ imported, resumed }, 'Task queue imported');
    return { imported, resumed };
  }

  // ── OpenMontage tool registry ──────────────────────────────

  async listOpenMontageTools(): Promise<any> {
    const installed = this.openmontage.isInstalled();
    const tools = installed ? await this.openmontage.listTools() : [];
    return { installed, repoDir: this.openmontage.repoDir, count: tools.length, tools };
  }

  // ── Image generation (Flux Schnell) ─────────────────────────

  async generateImage(prompt: string, opts?: { width?: number; height?: number; steps?: number }): Promise<any> {
    return this.imageGen.generate(prompt, {
      width: opts?.width,
      height: opts?.height,
      steps: opts?.steps,
    });
  }

  // ── Voice-to-text (STT) ───────────────────────────────────

  async getVoiceStatus(): Promise<any> {
    const asrProvider = this.configManager.raw.voice.asrProvider ?? 'none';
    const asrClient = asrProvider === 'whisper' ? this.whisperAsr : this.vibeVoiceAsr;
    const asrHealth = asrClient ? await asrClient.health().catch(() => null) : null;
    const stack = this.voiceStackHealth ? this.voiceStackHealth.snapshot() : null;
    return {
      enabled: this.speechToText?.available ?? false,
      provider: this.speechToText?.provider ?? 'none',
      model: this.configManager.raw.voice.sttModel,
      /** What to run to bring the configured STT server up. */
      fix: this.speechToText?.fixCommand,
      asr: {
        provider: asrProvider,
        url: asrProvider === 'whisper' ? this.configManager.raw.voice.whisperAsrUrl : this.configManager.raw.voice.vibevoiceAsrUrl,
        model: asrProvider === 'whisper' ? this.configManager.raw.voice.whisperAsrModel : this.configManager.raw.voice.vibevoiceAsrModel,
        ...(asrHealth
          ? {
              ok: asrHealth.ok,
              state: asrHealth.state,
              device: asrHealth.device,
              error: asrHealth.error,
            }
          : {}),
      },
      /** One-liner for the settings card: "Voice degraded: start whisper with …". */
      summary: stack?.summary ?? null,
      health: stack,
    };
  }

  /** Voice-stack health: cached report, or re-run every probe when refresh. */
  async getVoiceStackHealth(refresh = false): Promise<any> {
    if (!this.voiceStackHealth) {
      return {
        ok: true,
        checkedAt: Date.now(),
        reason: 'voice stack not configured (headless/cloud mode)',
        summary: 'Voice stack not probed (headless/cloud mode)',
        components: [],
        degraded: [],
        fixes: [],
      };
    }
    if (refresh) await this.voiceStackHealth.refresh();
    return this.voiceStackHealth.snapshot();
  }

  /**
   * Boot-time voice warnings.
   *
   * The config ships pointing at localhost STT/TTS ports (17510, 17520, …) and
   * nothing starts those servers automatically, so a cold machine would
   * otherwise fail every speak/transcribe call. Probe each configured server
   * once, log a *warning* naming the exact command that starts it plus the
   * fallback Umbra will use meanwhile, and let boot continue — a voice server
   * that is not running is a degraded stack, not a broken app.
   */
  private logVoiceServersNotRunning(): void {
    const log = getLogger();
    const v = this.configManager.raw.voice;
    const tts = this.configManager.raw.meeting.tts ?? 'none';

    const probe = (component: string, url: string, check: Promise<boolean>, fix: string, fallback: string): void => {
      check
        .then(running => {
          if (running) {
            log.info({ component, url }, `Voice server up: ${component}`);
            return;
          }
          log.warn(
            { component, url, fallback, fix, hint: `Voice degraded: start ${component} — ${fix}` },
            `Voice server not running: ${component} at ${url} — Umbra falls back to ${fallback}`,
          );
        })
        .catch(err => log.debug({ component, err: err?.message }, `Voice server probe failed: ${component}`));
    };

    const stt = v.sttProvider ?? 'none';
    if (v.enabled === true) {
      if (stt === 'faster-whisper') {
        probe(
          'Faster-Whisper STT',
          v.fasterWhisperUrl || 'http://127.0.0.1:17510',
          this.fasterWhisperStt!.isRunning().catch(() => false),
          VOICE_FIX.sttFasterWhisper,
          "the desktop app's Web Speech API (on-device, no server)",
        );
      } else if (stt === 'whisper-local') {
        probe(
          'whisper.cpp STT',
          v.sttEndpoint || 'http://localhost:8080',
          isReachable(v.sttEndpoint || 'http://localhost:8080'),
          VOICE_FIX.sttWhisperLocal,
          "the desktop app's Web Speech API (on-device, no server)",
        );
      } else if (stt === 'voicebox') {
        probe('Voicebox STT', v.voiceboxUrl || 'http://127.0.0.1:17493', this.voiceboxClient!.isRunning().catch(() => false), VOICE_FIX.sttVoicebox, "the desktop app's Web Speech API (on-device, no server)");
      }
    }
    if (tts === 'piper') {
      probe('Piper TTS', v.piperUrl || 'http://127.0.0.1:17520', this.piperTts!.isRunning().catch(() => false), VOICE_FIX.ttsPiper, 'Windows SAPI (built into Windows)');
    } else if (tts === 'voicebox') {
      probe('Voicebox TTS', v.voiceboxUrl || 'http://127.0.0.1:17493', this.voiceboxClient!.isRunning().catch(() => false), VOICE_FIX.ttsVoicebox, 'Windows SAPI (built into Windows)');
    }
    if ((v.asrProvider ?? 'none') === 'whisper') {
      probe('Whisper-ASR (diarization)', v.whisperAsrUrl || 'http://127.0.0.1:17501', this.whisperAsr!.isRunning().catch(() => false), VOICE_FIX.asrWhisper, 'plain STT without speaker labels');
    } else if ((v.asrProvider ?? 'none') === 'vibevoice') {
      probe('VibeVoice-ASR (diarization)', v.vibevoiceAsrUrl || 'http://127.0.0.1:17502', this.vibeVoiceAsr!.isRunning().catch(() => false), VOICE_FIX.asrVibeVoice, 'plain STT without speaker labels');
    }
  }

  /** Push-to-talk runtime state for /api/status and the PWA settings card. */
  getPushToTalkStatus(): Record<string, unknown> {
    const combo = this.configManager.raw.voice.pushToTalk || '';
    let micOk = false;
    const snapshot = this.voiceStackHealth?.snapshot();
    if (snapshot) {
      const mic = snapshot.components.find(c => c.component === 'mic');
      micOk = mic?.configured === true && mic?.ok === true;
    }
    return {
      enabled: this.configManager.raw.voice.enabled === true && Boolean(combo),
      combo,
      capturing: this.pushToTalk?.isCapturing ?? false,
      micOk,
    };
  }

  /**
   * (Re)arm push-to-talk: register the hotkey when a combo is configured and
   * the STT provider is available; otherwise disarm. Idempotent — safe at
   * boot and again at runtime from the phone toggle.
   */
  private armPushToTalk(combo: string): void {
    this.pushToTalkHotkey?.stop();
    this.pushToTalkHotkey = undefined;
    this.pushToTalk = undefined;
    const config = this.configManager.raw;
    if (!combo || !config.voice.enabled || !this.speechToText?.available) return;
    try {
      this.micRecorder = new MicRecorder();
      this.pushToTalk = new PushToTalkService({
        recorder: this.micRecorder,
        stt: {
          transcribe: async req => {
            const r = await this.speechToText!.transcribe(req);
            if (!r.ok) getLogger().warn({ error: r.error, fix: r.hint }, 'Push-to-talk heard nothing — STT provider not running');
            return { text: r.text };
          },
        },
        router: {
          route: async (text: string) => {
            const routed = this.skillRouter.route(text);
            return routed.direct && routed.skill ? `${routed.skill.name}: ${text}` : null;
          },
        },
        submitTask: async (description: string) => {
          const dispatch = await this.dispatchTask(description, 'auto');
          return dispatch.taskId;
        },
        speak: text => this.speakOut(text),
        confirm: () => {
          // Terminal bell — a zero-dependency confirmation beep.
          try { process.stdout.write('\x07'); } catch { }
        },
        format: 'wav',
      });
      this.pushToTalkHotkey = new GlobalHotkey({
        combo,
        pollMs: 100,
        onPress: () => void this.pushToTalk!.start(),
        onRelease: () => void this.pushToTalk!.stop(),
      });
      this.pushToTalkHotkey.start();
      getLogger().info({ combo }, 'Push-to-talk hotkey registered');
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Push-to-talk disabled — could not register the hotkey');
    }
  }

  /** Phone toggle: persist the push-to-talk hotkey and (re)arm it live. */
  async updatePushToTalk(combo: string, enabled?: boolean): Promise<Record<string, unknown>> {
    const on = enabled !== false && Boolean(combo.trim());
    const next = on ? combo.trim() : '';
    await this.configManager.updateVoice({ enabled: on, pushToTalk: next });
    this.armPushToTalk(next);
    return { enabled: on, combo: next };
  }

  async transcribeAudio(audioBase64: string, opts?: { format?: string; language?: string }): Promise<any> {
    if (!this.speechToText) throw new Error('Voice service not configured');
    const audio = Buffer.from(audioBase64, 'base64');
    const result = await this.speechToText.transcribe({
      audio,
      format: (opts?.format as 'wav' | 'mp3' | 'ogg' | 'webm' | 'flac' | 'm4a') || 'webm',
      language: opts?.language,
    });
    return { ...result };
  }

  /**
   * Voice command → task: transcribe the audio, then submit the spoken text
   * as a task (same pipeline as POST /api/chat). `target` routes like chat
   * ('auto' | 'cloud' | 'local' | deviceId).
   */
  async voiceCommand(audioBase64: string, opts?: { format?: string; language?: string; target?: string }): Promise<any> {
    if (!this.speechToText) throw new Error('Voice service not configured');
    const audio = Buffer.from(audioBase64, 'base64');
    const result = await this.speechToText.transcribe({
      audio,
      format: (opts?.format as 'wav' | 'mp3' | 'ogg' | 'webm' | 'flac' | 'm4a') || 'webm',
      language: opts?.language,
    });
    const text = (result.text || '').trim();
    if (!result.ok) {
      // Degraded, not a crash: the STT server is down. Say so with the fix
      // command so the client can tell the user how to restore it.
      throw new Error(result.error || 'Speech-to-text server not running');
    }
    if (!text) throw new Error('No speech recognized in the audio');
    const dispatch = await this.dispatchTask(text, opts?.target || 'auto');
    // Spoken acknowledgement closes the voice loop — the same TTS stack as
    // POST /api/voice/speak. Best-effort: a missing/quiet TTS engine must
    // not fail the voice command (headless/cloud nodes just report spoke:false).
    let spoke = false;
    try {
      await this.speakOut(`On it — ${text}`);
      spoke = true;
    } catch (err: any) {
      getLogger().warn({ err: err?.message }, 'Voice-command spoken confirmation failed');
    }
    return { text, dispatch, spoke };
  }

  // ── Persistent memory recall (past sessions / tasks) ──────────

  async recallMemory(query: string): Promise<any> {
    const similar = await this.memory.searchSimilar(query, { k: 10, kind: 'task' });
    const recent = this.memory.getRecentActivity(20);
    const facts = this.memory.getFacts(50);
    return {
      query,
      facts: facts.map(f => ({ text: f.text, createdAt: f.createdAt })),
      similar: similar.map(s => ({ text: s.text, distance: s.distance, createdAt: s.createdAt })),
      recent: recent.map(r => ({ description: r.description, status: r.status, createdAt: r.createdAt })),
    };
  }

  /** Store a permanent fact the user told the assistant about themselves. */
  async rememberMemory(text: string): Promise<any> {
    const id = this.memory.rememberFact(text);
    return { id, remembered: text, total: this.memory.getFacts().length };
  }

  // ── Screen awareness (see the screen + cursor, ask about it) ──

  async screenAsk(question: string, intent?: string): Promise<any> {
    if (!this.awareness) throw new Error('Screen awareness not available (headless/cloud mode)');
    return this.awareness.ask(question, intent === 'help' ? 'help' : 'answer');
  }

  async screenState(): Promise<any> {
    if (!this.awareness) throw new Error('Screen awareness not available (headless/cloud mode)');
    const s = await this.awareness.snapshot();
    return { snapshot: s ? s.snapshot : null };
  }

  /** Live screen view: latest frame metadata + cursor trail, no re-capture. */
  async screenLive(): Promise<any> {
    if (!this.awareness) throw new Error('Screen awareness not available (headless/cloud mode)');
    const latest = this.awareness.latest();
    return {
      watching: this.awareness.isWatching,
      snapshot: latest ? latest.snapshot : null,
      cursorTrail: this.awareness.cursorTrail(),
    };
  }

  /** Start/stop the always-on screen + cursor watch loop. */
  async screenWatch(enabled: boolean): Promise<any> {
    if (!this.awareness) throw new Error('Screen awareness not available (headless/cloud mode)');
    if (enabled) this.awareness.startWatching();
    else this.awareness.stopWatching();
    return { watching: this.awareness.isWatching };
  }

  // ── Meeting companion (join / hear / act / leave) ──────────

  async meetingJoin(url: string, opts?: { title?: string; topics?: string[] }): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    const meeting = await this.meetingCompanion.join(url, opts);
    const cable = this.configManager.raw.meeting.audioCable;
    if (this.configManager.raw.meeting.routeMic && cable && cable !== 'none') {
      try {
        await this.routeMeetingMic();
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'Could not auto-route the meeting mic to the virtual cable');
      }
    }
    return meeting;
  }

  async meetingStartListening(): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    this.meetingCompanion.startListening();
    return { status: this.meetingCompanion.status() };
  }

  async meetingStatus(): Promise<any> {
    const meeting = this.meetingCompanion?.status() ?? null;
    return {
      meeting: meeting
        ? {
            ...meeting,
            attendees: this.meetingCompanion!.getAttendees(),
          }
        : null,
    };
  }

  async meetingLeave(): Promise<any> {
    if (!this.meetingCompanion) throw new Error('No active meeting');
    let outcome: any;
    try {
      outcome = await this.meetingCompanion.leave();
      // Persist to MeetingStore + knowledge + memory
      try {
        const st: any = this.meetingCompanion?.status() || { url: outcome.url || '', transcript: [] };
        const id = `mtg-${Date.now()}`;
        const persisted = {
          id,
          url: st.url || '',
          title: st.title || outcome.summary?.slice(0, 80) || 'Meeting',
          startedAt: new Date(Date.now() - 60000).toISOString(),
          endedAt: new Date().toISOString(),
          attendees: outcome.attendees || st.attendees || [],
          transcript: st.transcript || [],
          summary: outcome.summary || '',
          actionItems: outcome.actionItems || [],
          decisions: outcome.decisions || [],
        };
        this.meetingStore?.save(persisted as any);
        this.memory.rememberFact(`Meeting ${persisted.title}: ${persisted.summary.slice(0, 300)}`);
        await this.knowledge.addOrUpdate(`meeting/${id}`, persisted.title, `${persisted.summary}\n\nAttendees: ${persisted.attendees.join(', ')}\nURL: ${persisted.url}`, ['meeting'], [], 'system').catch(() => {});
      } catch {}
    } finally {
      // Restore the original mic even if leave/summary throws — the cable must
      // not stay selected after the meeting ends.
      try {
        const restored = await this.restoreMeetingMic();
        if (restored) getLogger().info('Meeting mic restored to its original default');
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'Could not restore the meeting mic to its original default');
      }
    }
    return outcome;
  }

  async meetingExecute(action: string, params: Record<string, unknown>): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    return { result: await this.meetingCompanion.execute(action, params) };
  }

  async meetingFeedAudio(audioBase64: string, format?: string): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    const segment = await this.meetingCompanion.feedAudio(Buffer.from(audioBase64, 'base64'), format || 'webm');
    return { segment };
  }

  async meetingShare(target?: string): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    return { result: await this.meetingCompanion.shareScreen(target) };
  }

  async meetingStopShare(): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    return { result: await this.meetingCompanion.stopShare() };
  }

  async meetingOrders(): Promise<any> {
    return { orders: this.meetingCompanion?.getOrders() ?? [] };
  }

  async meetingSpeak(text: string, opts?: { voice?: string; language?: string }): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    return { result: await this.meetingCompanion.speak(text, opts) };
  }

  async meetingMute(muted: boolean): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    return { result: await this.meetingCompanion.muteMic(muted) };
  }

  async meetingRaiseHand(raised: boolean): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    return { result: await this.meetingCompanion.raiseHand(raised) };
  }

  async meetingChat(message: string): Promise<any> {
    if (!this.meetingCompanion) throw new Error('Meeting companion not available (headless/cloud mode)');
    return { result: await this.meetingCompanion.sendChat(message) };
  }

  /** Speak in a meeting using the configured TTS provider (meeting.tts). */
  private async speakForMeeting(text: string, opts?: { voice?: string; language?: string }): Promise<string> {
    const cable = this.configManager.raw.meeting.audioCable;
    if (cable && cable !== 'none') {
      const deviceId = await this.resolveCableDevice(cable);
      const { wav, label } = await this.synthesizeWav(text, opts);
      await this.audioRouter!.play(wav, deviceId);
      return `Spoke into the meeting via virtual cable (${label})`;
    }

    const tts = this.configManager.raw.meeting.tts;
    if (tts === 'voicebox') {
      if (!this.voiceboxClient || !(await this.voiceboxClient.isRunning())) {
        throw new Error('Voicebox is not running — start the Voicebox app (http://127.0.0.1:17493)');
      }
      const voice = this.configManager.raw.voice;
      await this.voiceboxClient.speak(text, {
        profile: opts?.voice || voice.voiceboxProfile || undefined,
        language: opts?.language,
        engine: voice.voiceboxEngine,
      });
      return 'Spoke (voicebox)'; 
    }
    if (tts === 'vibevoice') {
      if (!this.vibeVoiceTts?.installed) {
        throw new Error('VibeVoice not installed — run scripts/vibevoice-install.sh (needs Python 3.10+ and a GPU recommended)');
      }
      const res = await this.vibeVoiceTts.speak(text, {
        voice: opts?.voice || this.configManager.raw.voice.vibevoiceVoice,
        language: opts?.language || this.configManager.raw.voice.vibevoiceLanguage,
      });
      await this.audioRouter?.play(res.wav);
      return `Spoke (${res.voice})`;
    }
    if (tts === 'piper') {
      if (!this.piperTts) throw new Error('Piper TTS not initialized');
      const spoken = await this.piperTts.speakWithFallback(text, {
        voice: opts?.voice || this.configManager.raw.voice.piperVoice,
        language: opts?.language,
      });
      await this.audioRouter?.play(spoken.wav);
      if (spoken.degraded) {
        getLogger().warn({ fix: spoken.fix }, 'Meeting TTS spoke with Windows SAPI — Piper not running');
        return 'Spoke (Windows SAPI fallback — Piper TTS not running)';
      }
      return `Spoke (piper)`;
    }
    if (tts === 'local') {
      if (!this.windowsTts?.available) throw new Error('Windows TTS is only available on Windows');
      await this.windowsTts.speak(text);
      return 'Spoke';
    }
    throw new Error('Meeting TTS is disabled — set meeting.tts to local, piper, vibevoice or voicebox');
  }

  /** Synthesize meeting speech to WAV bytes using the configured provider (meeting.tts). */
  private async synthesizeWav(text: string, opts?: { voice?: string; language?: string }): Promise<{ wav: Buffer; label: string }> {
    const tts = this.configManager.raw.meeting.tts;
    if (tts === 'voicebox') {
      if (!this.voiceboxClient || !(await this.voiceboxClient.isRunning())) {
        throw new Error('Voicebox is not running — start the Voicebox app (http://127.0.0.1:17493)');
      }
      const voice = this.configManager.raw.voice;
      const profile = opts?.voice || voice.voiceboxProfile || undefined;
      const wav = await this.voiceboxClient.synthesize(text, {
        profile,
        language: opts?.language,
        engine: voice.voiceboxEngine,
      });
      return { wav, label: `voicebox (${profile || 'default profile'})` };
    }
    if (tts === 'vibevoice') {
      if (!this.vibeVoiceTts?.installed) {
        throw new Error('VibeVoice not installed — run scripts/vibevoice-install.sh (needs Python 3.10+ and a GPU recommended)');
      }
      const res = await this.vibeVoiceTts.speak(text, {
        voice: opts?.voice || this.configManager.raw.voice.vibevoiceVoice,
        language: opts?.language || this.configManager.raw.voice.vibevoiceLanguage,
      });
      return { wav: res.wav, label: res.voice };
    }
    if (tts === 'piper') {
      if (!this.piperTts) throw new Error('Piper TTS not initialized');
      const spoken = await this.piperTts.speakWithFallback(text, {
        voice: opts?.voice || this.configManager.raw.voice.piperVoice,
        language: opts?.language,
      });
      return { wav: spoken.wav, label: spoken.degraded ? 'windows SAPI (piper down)' : `piper (${this.configManager.raw.voice.piperVoice})` };
    }
    if (tts === 'local') {
      if (!this.windowsTts?.available) throw new Error('Windows TTS is only available on Windows');
      const wav = await this.windowsTts.synthesize(text);
      return { wav, label: 'windows SAPI' };
    }
    throw new Error('Meeting TTS is disabled — set meeting.tts to local, piper, vibevoice or voicebox');
  }

  /** Resolve the cable render device ('auto' or a name/id) to its endpoint id. */
  private async resolveCableDevice(cable: string): Promise<string> {
    if (!this.audioRouter?.available) throw new Error('Virtual-cable routing is Windows-only');
    const render = await this.audioRouter.listDevices('render');
    if (cable === 'auto') {
      const found = findCable(render, 'render');
      if (!found) throw new Error('No virtual audio cable found — install VB-Cable (https://vb-audio.com/Cable) and retry');
      return found.id;
    }
    const match = render.find(
      d => d.id === cable || d.name.toLowerCase() === cable.toLowerCase() || d.name.toLowerCase().includes(cable.toLowerCase()),
    );
    if (!match) {
      throw new Error(`Audio device "${cable}" not found. Render devices: ${render.map(d => d.name).join(', ') || '(none)'}`);
    }
    return match.id;
  }

  /** Set the default mic to the cable's output side so the call picks up Umbra's speech. */
  private async routeMeetingMic(): Promise<string> {
    if (!this.audioRouter?.available) throw new Error('Virtual-cable routing is Windows-only');
    const output = await this.audioRouter.findCable('capture');
    if (!output) throw new Error('No virtual cable "CABLE Output" found — install VB-Cable and retry');
    // Remember the pre-meeting default mic once, so it can be restored on leave
    // even across back-to-back meetings with routeMic on.
    if (!this.savedMicDeviceId) {
      this.savedMicDeviceId = (await this.audioRouter.getDefault('capture')) ?? undefined;
    }
    await this.audioRouter.setDefault('capture', output.id);
    return `Mic routed to ${output.name}`;
  }

  /** Restore the default mic to whatever it was before routeMeetingMic ran. */
  private async restoreMeetingMic(): Promise<string | null> {
    if (!this.savedMicDeviceId || !this.audioRouter?.available) return null;
    const restored = this.savedMicDeviceId;
    await this.audioRouter.setDefault('capture', restored);
    this.savedMicDeviceId = undefined;
    return restored;
  }

  /** Speak on the PC (outside a meeting), optionally with a voice/language. */
  async speakOut(text: string, opts?: { voice?: string; language?: string; provider?: string; engine?: string }): Promise<any> {
    const v = this.configManager.raw.voice;
    let provider = opts?.provider;
    if (!provider) {
      if (this.piperTts && await this.piperTts.isRunning().catch(() => false)) provider = 'piper';
      else if (this.voiceboxClient && await this.voiceboxClient.isRunning().catch(() => false)) provider = 'voicebox';
      else if (this.vibeVoiceTts?.installed) provider = 'vibevoice';
      else provider = 'windows';
    }
    if (provider === 'piper') {
      if (!this.piperTts) {
        if (this.voiceboxClient && await this.voiceboxClient.isRunning().catch(() => false)) provider = 'voicebox';
        else if (this.vibeVoiceTts?.installed) provider = 'vibevoice';
        else provider = 'windows';
      } else {
        // PiperTts.speakWithFallback covers the "server never started" case by
        // rendering the same WAV with Windows SAPI, so we don't re-probe here.
        const spoken = await this.piperTts.speakWithFallback(text, {
          voice: opts?.voice || v.piperVoice,
          language: opts?.language,
        });
        await this.audioRouter?.play(spoken.wav);
        if (spoken.degraded) {
          getLogger().warn({ fix: spoken.fix }, 'Spoke with Windows SAPI — Piper TTS is not running');
          return { result: 'Spoke (Windows SAPI fallback)', voice: opts?.voice || v.piperVoice, degraded: true, provider: spoken.provider, error: spoken.error, fix: spoken.fix };
        }
        return { result: 'Spoke (piper)', voice: opts?.voice || v.piperVoice, provider: spoken.provider, degraded: false };
      }
    }
    if (provider === 'voicebox') {
      if (!this.voiceboxClient || !(await this.voiceboxClient.isRunning())) {
        // fallback chain: voicebox down → vibevoice → windows
        if (this.vibeVoiceTts?.installed) provider = 'vibevoice';
        else provider = 'windows';
      } else {
        await this.voiceboxClient.speak(text, {
          profile: opts?.voice || v.voiceboxProfile || undefined,
          language: opts?.language,
          engine: opts?.engine || v.voiceboxEngine,
        });
        return { result: 'Spoke (voicebox)', voice: opts?.voice || v.voiceboxProfile };
      }
    }
    if (provider === 'vibevoice') {
      if (!this.vibeVoiceTts?.installed) {
        throw new Error('VibeVoice not installed — run scripts/vibevoice-install.sh');
      }
      const res = await this.vibeVoiceTts.speak(text, {
        voice: opts?.voice || v.vibevoiceVoice,
        language: opts?.language || v.vibevoiceLanguage,
      });
      await this.audioRouter?.play(res.wav);
      return { result: `Spoke (${res.voice})`, voice: res.voice, language: res.language, path: res.path };
    }
    if (provider === 'windows' || provider === 'local') {
      if (!this.windowsTts?.available) throw new Error('Windows TTS is only available on Windows');
      await this.windowsTts.speak(text);
      return { result: 'Spoke (Windows SAPI)' };
    }
    throw new Error(`Unknown TTS provider: ${provider} (use voicebox, vibevoice or windows)`);
  }

  // ── Audio routing (virtual cable) ───────────────────────────

  async listAudioDevices(): Promise<any> {
    if (!this.audioRouter) return { available: false, devices: [] };
    return {
      available: this.audioRouter.available,
      devices: await this.audioRouter.listDevices('both').catch(() => []),
    };
  }

  async setAudioDefault(opts: { flow?: 'render' | 'capture'; deviceId?: string }): Promise<any> {
    if (!this.audioRouter) throw new Error('Audio router not available (headless/cloud mode)');
    const flow: 'render' | 'capture' = opts?.flow === 'capture' ? 'capture' : 'render';
    if (!opts?.deviceId) throw new Error('deviceId is required');
    await this.audioRouter.setDefault(flow, opts.deviceId);
    return { result: `Default ${flow} device set to ${opts.deviceId}` };
  }

  /** List the available TTS providers + voices (VibeVoice speakers, Voicebox profiles). */
  async listTtsVoices(): Promise<any> {
    let voiceboxRunning = false;
    let voiceboxProfiles: any[] = [];
    if (this.voiceboxClient) {
      voiceboxRunning = await this.voiceboxClient.isRunning().catch(() => false);
      voiceboxProfiles = voiceboxRunning ? await this.voiceboxClient.listProfiles().catch(() => []) : [];
    }
    return {
      windows: this.windowsTts?.available ?? false,
      vibevoice: {
        installed: this.vibeVoiceTts?.installed ?? false,
        model: this.configManager.raw.voice.vibevoiceModel,
        defaultVoice: this.configManager.raw.voice.vibevoiceVoice,
        defaultLanguage: this.configManager.raw.voice.vibevoiceLanguage,
        voices: this.vibeVoiceTts?.listVoices() ?? [],
      },
      voicebox: {
        running: voiceboxRunning,
        url: this.configManager.raw.voice.voiceboxUrl,
        defaultProfile: this.configManager.raw.voice.voiceboxProfile,
        profiles: voiceboxProfiles,
      },
    };
  }

  // ── Meeting screen-share + order helpers (DOM automation + native shortcuts) ──

  /**
   * Which native meeting app to drive, per config.meeting.nativeApp.
   * Explicit 'zoom'/'teams' always wins; 'auto' falls back to a running app
   * only when there is no browser meeting tab (so a stray Zoom window can't
   * hijack controls while a Meet tab is the actual meeting).
   */
  private nativeMeetingApp(): 'zoom' | 'teams' | null {
    const pref = this.configManager.raw.meeting.nativeApp ?? 'auto';
    if (pref === 'none') return null;
    if (pref === 'zoom' || pref === 'teams') return pref;
    const url = this.meetingCompanion?.status()?.url || '';
    if (url) return null; // browser meeting → DOM automation
    return detectNativeMeetingApp(pref, proc => getWindowRect(proc) !== null);
  }

  /** Send a native-app control shortcut: focus the app window, then SendInput. */
  private async sendNativeMeetingControl(app: 'zoom' | 'teams', action: NativeMeetingAction): Promise<string> {
    const shortcut = nativeShortcut(app, action);
    if (!shortcut) {
      return `No reliable ${app} shortcut for "${action}" — use the meeting UI (e.g. click Stop Share).`;
    }
    const proc = nativeProcessName(app);
    if (!focusWindow(proc)) {
      return `Could not find a running ${app} window (${proc}) — is the app open and in the meeting?`;
    }
    sendHotkey(shortcut);
    return `Sent ${app} shortcut ${shortcut} (${action})`;
  }

  private async shareScreenInMeeting(target?: string): Promise<string> {
    if (this.configManager.raw.meeting.screenShare === false) {
      throw new Error('Screen sharing is disabled (meeting.screenShare)');
    }
    const nativeApp = this.nativeMeetingApp();
    if (nativeApp) return this.sendNativeMeetingControl(nativeApp, 'share');
    const provider = detectMeetingProvider(this.meetingCompanion?.status()?.url || '');
    const shareTarget: ShareTarget = target === 'window' || target === 'tab' ? target : 'screen';
    try {
      return await this.meetingTabJs(meetingShareScript(provider, shareTarget));
    } catch (err: any) {
      return `Screen-share automation failed: ${err.message}. Click the Share button in the meeting yourself.`;
    }
  }

  private async stopScreenShareInMeeting(): Promise<string> {
    if (this.configManager.raw.meeting.screenShare === false) {
      throw new Error('Screen sharing is disabled (meeting.screenShare)');
    }
    const nativeApp = this.nativeMeetingApp();
    if (nativeApp) return this.sendNativeMeetingControl(nativeApp, 'stopShare');
    const provider = detectMeetingProvider(this.meetingCompanion?.status()?.url || '');
    try {
      return await this.meetingTabJs(meetingStopShareScript(provider));
    } catch (err: any) {
      return `Stop-share automation failed: ${err.message}. Click "Stop sharing" yourself.`;
    }
  }

  /** Mute/unmute the mic (native app shortcut, else DOM automation). */
  private async controlMeetingMic(muted: boolean): Promise<string> {
    const nativeApp = this.nativeMeetingApp();
    if (nativeApp) return this.sendNativeMeetingControl(nativeApp, muted ? 'mute' : 'unmute');
    const provider = detectMeetingProvider(this.meetingCompanion?.status()?.url || '');
    try {
      return await this.meetingTabJs(meetingMuteScript(provider, muted));
    } catch (err: any) {
      return `Mic ${muted ? 'mute' : 'unmute'} automation failed: ${err.message}. Toggle the mic yourself.`;
    }
  }

  /** Raise/lower the hand (native app shortcut, else DOM automation). */
  private async controlMeetingHand(raised: boolean): Promise<string> {
    const nativeApp = this.nativeMeetingApp();
    if (nativeApp) return this.sendNativeMeetingControl(nativeApp, raised ? 'raiseHand' : 'lowerHand');
    const provider = detectMeetingProvider(this.meetingCompanion?.status()?.url || '');
    try {
      return await this.meetingTabJs(meetingRaiseHandScript(provider, raised));
    } catch (err: any) {
      return `Hand ${raised ? 'raise' : 'lower'} automation failed: ${err.message}. Use the meeting UI yourself.`;
    }
  }

  /** Send a message in the meeting chat (best-effort DOM automation). */
  private async chatInMeeting(message: string): Promise<string> {
    const provider = detectMeetingProvider(this.meetingCompanion?.status()?.url || '');
    try {
      return await this.meetingTabJs(meetingChatScript(provider, message));
    } catch (err: any) {
      return `Chat automation failed: ${err.message}. Paste the message in the meeting chat yourself.`;
    }
  }

  /** Run a JS snippet in the meeting tab (the user's real Chrome). */
  private async meetingTabJs(expression: string): Promise<string> {
    if (!this.realDesktop) throw new Error('Real desktop control unavailable');
    return this.realDesktop.evaluate(expression);
  }

  /** Answer a search order without disturbing the meeting (LLM-grounded). */
  private async searchForMeeting(query: string): Promise<string> {
    const res = await this.llm.complete(
      [{ role: 'user', content: `Answer this question concisely (the user is in a meeting and needs a quick answer): ${query}` }],
      'fast',
      { maxTokens: 400 },
    );
    return res.content;
  }

  private async noteForMeeting(text: string): Promise<string> {
    if (text) this.memory.rememberFact(`Meeting note: ${text}`);
    return `Note recorded: ${text}`;
  }

  private async reminderForMeeting(text: string): Promise<string> {
    if (text) this.memory.rememberFact(`Reminder: ${text}`);
    return `Reminder set: ${text}`;
  }

  // ── Device mesh (always-on hub + auto-reconnecting client) ──

  /** Connect this node to a remote hub (the cloud) with its persisted token. */
  private startDeviceClient(): void {
    if (!this.configManager) return;
    const hubUrl = process.env.UMBRA_HUB_URL || this.configManager.raw.devices.hubUrl;
    const token = process.env.UMBRA_HUB_TOKEN || this.configManager.raw.devices.hubToken;
    if (!hubUrl) return;
    if (!token) {
      getLogger().warn('devices.hubUrl set without a hub token — call joinRemoteHub(code) to register this device');
      return;
    }
    const deviceId = process.env.UMBRA_HUB_DEVICE_ID || this.configManager.raw.devices.hubDeviceId;
    this.deviceClient?.stop();
    this.deviceClient = new DeviceClient({
      url: hubUrl,
      token,
      deviceId,
      name: this.configManager.raw.devices.name,
      role: this.configManager.raw.devices.role,
      capabilities: ['agent', 'desktop-control'],
      onMessage: (from, msg) => this.handleDeviceMessage(from, msg),
      onStatus: connected => getLogger().info({ connected }, 'Device client hub status'),
    });
    this.deviceClient.start();
  }

  /**
   * Bootstrap a fresh device into the mesh: call the cloud's join endpoint
   * with an invite code, persist the long-lived token, and connect. After this
   * the device auto-reconnects forever (the "scan a QR / open a link" step).
   */
  async joinRemoteHub(code: string, apiBase?: string): Promise<any> {
    const base = (apiBase || process.env.UMBRA_API_URL || '').replace(/\/$/, '');
    if (!base) throw new Error('UMBRA_API_URL (cloud API base) is required to join a remote hub');
    const c = this.configManager.raw.devices;
    const res = await fetch(`${base}/api/devices/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: c.name, role: c.role, capabilities: ['agent', 'desktop-control'] }),
    });
    if (!res.ok) throw new Error(`Join failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { join: { deviceId: string; token: string } };
    this.configManager.raw.devices.hubToken = body.join.token;
    this.configManager.raw.devices.hubDeviceId = body.join.deviceId;
    await this.configManager.saveConfig();
    this.startDeviceClient();
    return { deviceId: body.join.deviceId, connected: this.deviceClient?.isConnected ?? false };
  }

  /** Handle a message relayed to this device from another device (via the hub). */
  private async handleDeviceMessage(from: string, msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.t || '');
    if (type === 'cmd') {
      const action = String(msg.action || '');
      const params = (msg.params as Record<string, unknown>) || {};
      const reqId = String(msg.reqId || '');
      let ok = true;
      let result: string;
      try {
        result = this.realDesktop
          ? await this.executeGhost(action, params)
          : await this.executeDesktop2(action, params);
      } catch (err: any) {
        ok = false;
        result = err.message || 'error';
      }
      this.deviceClient?.relay(from, { t: 'result', reqId, ok, result });
      return;
    }
    if (type === 'task') {
      const description = String(msg.description || '').trim();
      const reqId = String(msg.reqId || '');
      if (!description) {
        if (reqId) this.deviceClient?.reply(reqId, { t: 'task-error', error: 'description is required' });
        else this.deviceClient?.relay(from, { t: 'task-error', error: 'description is required' });
        return;
      }
      let taskId: string;
      try {
        taskId = await this.submitTask(description);
      } catch (err: any) {
        // Relay the failure to the originator so its task list learns the
        // outcome instead of only seeing an HTTP error from the relay reply.
        this.deviceClient?.relay(from, {
          t: 'task-event',
          event: 'task:failed',
          node: this.role,
          task: { id: 'pending-' + reqId, description, status: 'failed', error: err?.message || 'submit failed' },
        });
        if (reqId) this.deviceClient?.reply(reqId, { t: 'task-error', error: err?.message || 'submit failed' });
        else this.deviceClient?.relay(from, { t: 'task-error', error: err?.message || 'submit failed' });
        return;
      }
      // Deterministic sync back to the originating device: the requester gets
      // its task-accepted reply AND a task-event snapshot carrying the assigned
      // id, so its task list updates immediately without waiting for the
      // executor's broadcast (which only runs when a TaskSyncBridge is wired).
      this.deviceClient?.relay(from, {
        t: 'task-event',
        event: 'task:created',
        node: this.role,
        task: { id: taskId, description, status: 'pending' },
      });
      // Remember the origin so the sync bridge relays the FULL lifecycle
      // (started/progress/completed/failed/cancelled) back to this device.
      this.taskSyncBridge?.registerOrigin(taskId, from);
      if (reqId) this.deviceClient?.reply(reqId, { t: 'task-accepted', taskId });
      else this.deviceClient?.relay(from, { t: 'task-accepted', taskId });
    }
  }

  // ── Rust mesh (P2P transport) ─────────────────────────────

  /** Map compiler.backend → a NativeBackend (or undefined for metadata-only). */
  private nativeBackend(backend: 'none' | 'node' | 'tcc' | 'clang'): import('./core/skill/SkillCompiler').NativeBackend | undefined {
    switch (backend) {
      case 'tcc': return new CppBackend({ cc: 'tcc', emitOnly: true });
      case 'clang': return new CppBackend({ cc: 'clang++', emitOnly: true });
      case 'node': return new NoopBackend();
      case 'none':
      default: return undefined;
    }
  }

  /**
   * Promote hot skills (from the recorder) to native artifacts via the
   * compiler backend. Maps catalog skills → SkillSpec → CompiledSkill, so
   * the "compile hot skills to native" loop is actually exercised.
   */
  async compileHotSkills(threshold = 20): Promise<any> {
    const hotIds = this.skillRecorder.hotSkills(threshold);
    const compiled: any[] = [];
    for (const id of hotIds) {
      const skill = ALL_SKILLS.find(s => s.id === id);
      if (!skill) continue;
      const spec = {
        name: skill.name,
        version: '1.0.0',
        domain: skill.domain,
        description: skill.purpose,
        systemPrompt: `Skill: ${skill.name}\nPurpose: ${skill.purpose}\nSuccess: ${skill.success}`,
        tools: [{ name: 'execute', description: skill.purpose, inputSchema: { input: 'string' }, native: true }],
        triggers: skill.triggers,
        memorySize: 0,
        hot: true,
      };
      compiled.push(await this.skillCompiler.compile(spec));
    }
    return { hot: hotIds, compiled };
  }

  async meshStatus(): Promise<any> {
    return this.mesh ? this.mesh.status() : { running: false, enabled: false, reason: 'mesh not configured (desktop p2p disabled or headless)' };
  }

  async meshPair(ttl = 120): Promise<any> {
    if (!this.mesh) throw new Error('Mesh daemon not configured');
    const pair = await this.mesh.pair(ttl);
    return {
      deviceId: pair.device_id,
      wire: pair.wire,
      exp: pair.exp,
      qrAscii: pair.qr_ascii,
    };
  }

  async meshPairDemo(): Promise<any> {
    if (!this.mesh) throw new Error('Mesh daemon not configured');
    return this.mesh.pairDemo();
  }

  async meshRevoke(deviceId: string): Promise<any> {
    if (!this.mesh) throw new Error('Mesh daemon not configured');
    return this.mesh.revoke(deviceId);
  }

  async getDevices(): Promise<any> {
    if (!this.deviceRegistry) return { registered: [], connected: [], hub: null };
    const online = (id: string) => this.deviceHub?.isOnline(id) ?? false;
    const snap = this.modelRouter.snapshot();
    return {
      deviceLimit: deviceLimitLabel(this.configManager.raw.plan.tier),
      plan: {
        tier: snap.plan,
        name: snap.planName,
        budgetUsd: snap.monthlyBudgetUsd,
        remainingUsd: snap.remainingUsd,
      },
      registered: this.deviceRegistry.listDevices().map(d => ({
        deviceId: d.deviceId,
        name: d.name,
        role: d.role,
        capabilities: d.capabilities,
        online: online(d.deviceId),
        lastSeen: d.lastSeen,
      })),
      hub: this.deviceHub?.getStatus() ?? null,
      thisNode: {
        role: this.role,
        connectedToHub: this.deviceClient?.isConnected ?? false,
        hubDeviceId: this.configManager?.raw.devices.hubDeviceId,
      },
    };
  }

  async createDeviceInvite(name: string): Promise<any> {
    if (!this.deviceRegistry) throw new Error('Device mesh disabled');
    const invite = this.deviceRegistry.createInvite(name || undefined);
    return {
      code: invite.code,
      expiresAt: invite.expiresAt,
      // Phone scans the QR (which encodes this payload); a PC opens joinUrl.
      joinUrl: `${this.publicBaseUrl()}/api/devices/join?code=${invite.code}`,
      hubWsUrl: this.hubWsUrl(),
    };
  }

  async joinDevice(code: string, meta: { name: string; role?: string; capabilities?: string[] }): Promise<any> {
    if (!this.deviceRegistry) throw new Error('Device mesh disabled');
    // Plan gate: free/byok/pro allow 1 device, ultimate unlimited. Existing
    // devices keep reconnecting; only NEW registrations are limited.
    const tier = this.configManager.raw.plan.tier;
    assertCanJoinDevice(tier, this.deviceRegistry.listDevices().length);
    const roles = ['desktop', 'phone', 'server', 'other'] as const;
    const role = roles.includes(meta.role as any) ? (meta.role as 'desktop' | 'phone' | 'server' | 'other') : 'other';
    const result = this.deviceRegistry.redeemInvite(code, { name: meta.name, role, capabilities: meta.capabilities });
    return {
      deviceId: result.deviceId,
      token: result.token,
      name: result.device.name,
      role: result.device.role,
      deviceLimit: deviceLimitLabel(tier),
      hubWsUrl: this.hubWsUrl(),
    };
  }

  async revokeDevice(deviceId: string): Promise<any> {
    if (!this.deviceRegistry) throw new Error('Device mesh disabled');
    this.deviceRegistry.revokeDevice(deviceId);
    return { deviceId };
  }

  async sendToDevice(deviceId: string, msg: Record<string, unknown>): Promise<any> {
    if (!this.deviceHub) throw new Error('Device mesh disabled');
    const sent = this.deviceHub.send(deviceId, msg);
    return { deviceId, sent };
  }

  private publicBaseUrl(): string {
    return (process.env.UMBRA_PUBLIC_URL || `http://localhost:8787`).replace(/\/$/, '');
  }

  private hubWsUrl(): string {
    try {
      const u = new URL(this.publicBaseUrl());
      const proto = u.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${u.hostname}:${this.configManager.raw.devices.hubPort}/device-ws`;
    } catch {
      return `ws://localhost:${this.configManager.raw.devices.hubPort}/device-ws`;
    }
  }

  private async syncOpenMontageTools(): Promise<number> {
    if (!this.openmontage.isInstalled()) return 0;
    const tools = await this.openmontage.listTools();
    for (const tool of tools) {
      this.mcpRegistry.register('openmontage', tool.name.replace(/[^a-zA-Z0-9_-]/g, ''), { transport: 'native' });
    }
    if (tools.length) getLogger().info({ count: tools.length }, 'OpenMontage tools registered');
    return tools.length;
  }

  async getMacros(): Promise<any> {
    return this.memory.getAllMacros();
  }

  async getActivitySummary(): Promise<any> {
    return this.memory.getActivitySummary();
  }

  async getLearnedPatterns(): Promise<any> {
    return this.memory.getHighConfidencePatterns();
  }

  async getSessions(): Promise<any> {
    return this.memory.getSessions();
  }

  async getPrivacyStats(): Promise<any> {
    return this.privacy.getStats();
  }

  async getPrivacyAudit(): Promise<any> {
    return this.privacy.getAuditLog();
  }

  async addPrivacyRule(type: 'app' | 'url', pattern: string): Promise<void> {
    if (type === 'app') this.privacy.addBlockedApp(pattern);
    else this.privacy.addBlockedUrl(pattern);
  }

  async getDesktop2State(): Promise<any> {
    return this.desktop2.getState();
  }

  async queryJournal(question: string): Promise<string> {
    if (!this.initialized) return 'Umbra OS not initialized';
    return this.journal.queryAgent(question);
  }

  async generateJournalNow(date?: Date): Promise<any> {
    return this.journal.generateDailyJournal(date || new Date());
  }

  async rebuildTopicIndex(): Promise<void> {
    this.topicIndexer.rebuildIndex();
  }

  async manuallingestKnowledge(): Promise<any> {
    return this.bridge.ingestSince(new Date(Date.now() - 86400000));
  }

  async getProactiveSuggestions(): Promise<any> {
    const context = this.memory.getUserActivityPatterns(15);
    return this.proactive['generateSuggestions'](context);
  }

  async analyzePatterns(): Promise<void> {
    await this.macros.analyzePatterns();
  }

  // ── Social automation (X.com / YouTube / Instagram) ───────

  async socialPost(opts: {
    platform: string;
    action: string;
    email: string;
    password: string;
    text?: string;
    comment_text?: string;
    query?: string;
    media_files?: string[];
    video_path?: string;
    title?: string;
    description?: string;
    max_comments?: number;
    max_results?: number;
    headless?: boolean;
  }): Promise<any> {
    const platform = opts.platform as 'x' | 'youtube' | 'instagram';
    if (!['x', 'youtube', 'instagram'].includes(platform)) throw new Error(`Unknown platform: ${opts.platform}`);
    const action = opts.action as 'post' | 'comment' | 'search' | 'upload' | 'login';
    if (!['post', 'comment', 'search', 'upload', 'login'].includes(action)) throw new Error(`Unknown action: ${opts.action}`);

    const payload: any = {
      platform,
      action,
      email: opts.email,
      password: opts.password,
      headless: opts.headless ?? true,
    };
    if (opts.text !== undefined) payload.text = opts.text;
    if (opts.comment_text !== undefined) payload.comment_text = opts.comment_text;
    if (opts.query !== undefined) payload.query = opts.query;
    if (opts.media_files !== undefined) payload.media_files = opts.media_files;
    if (opts.video_path !== undefined) payload.video_path = opts.video_path;
    if (opts.title !== undefined) payload.title = opts.title;
    if (opts.description !== undefined) payload.description = opts.description;
    if (opts.max_comments !== undefined) payload.max_comments = opts.max_comments;
    if (opts.max_results !== undefined) payload.max_results = opts.max_results;

    return this.social.execute(payload);
  }

  async socialSchedule(opts: {
    platform: string;
    action: string;
    email: string;
    password: string;
    text?: string;
    video_path?: string;
    title?: string;
    description?: string;
    scheduledAt: number;
  }): Promise<any> {
    const platform = opts.platform as 'x' | 'youtube' | 'instagram';
    if (!['x', 'youtube', 'instagram'].includes(platform)) throw new Error(`Unknown platform: ${opts.platform}`);
    const action = opts.action as 'post' | 'upload';
    if (!['post', 'upload'].includes(action)) throw new Error('Scheduled action must be post or upload');

    const payload: any = {
      platform,
      action,
      email: opts.email,
      password: opts.password,
      headless: true,
    };
    if (opts.text !== undefined) payload.text = opts.text;
    if (opts.video_path !== undefined) payload.video_path = opts.video_path;
    if (opts.title !== undefined) payload.title = opts.title;
    if (opts.description !== undefined) payload.description = opts.description;

    return this.social.schedule(payload, opts.scheduledAt);
  }

  async socialScheduled(): Promise<any> {
    return this.social.getScheduled();
  }

  async socialCancelSchedule(id: string): Promise<any> {
    return this.social.cancelScheduled(id);
  }

  async socialStatus(): Promise<any> {
    return this.social.getStatus();
  }

  // ── Smart Home (Samsung SmartThings) ─────────────────────

  async smartDevices(): Promise<any> {
    if (this.smartHomeHub.active().length > 0) {
      const timeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([
        p,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Smart Home request timed out — a connected platform may be unreachable')), ms)),
      ]);
      return timeout(this.smartHomeHub.getDevices({ withStates: true }), 15000);
    }
    throw new Error('Smart Home is not configured — connect a platform in Smart Home → Connect');
  }

  async smartCommand(deviceId: string, command: 'on' | 'off'): Promise<any> {
    // Namespaced ids (<platform>:<nativeId>) route through the multi-platform hub.
    if (deviceId.includes(':')) {
      if (this.smartHomeHub.active().length === 0) throw new Error('Smart Home is not configured — connect a platform in Smart Home → Connect');
      return this.smartHomeHub.sendCommand(deviceId, command);
    }
    if (!this.smartThings.isConfigured()) throw new Error('SmartThings is not configured — connect your PAT in Smart Home → Connect');
    return this.smartThings.sendCommand(deviceId, command);
  }

  async smartControlByName(name: string, command: 'on' | 'off'): Promise<any> {
    if (this.smartHomeHub.active().length > 0) return this.smartHomeHub.controlByName(name, command);
    if (!this.smartThings.isConfigured()) throw new Error('SmartThings is not configured — connect your PAT in Smart Home → Connect');
    return this.smartThings.controlByName(name, command);
  }

  async smartSchedules(): Promise<any> {
    return this.smartScheduler.list();
  }

  async smartScheduleAdd(rule: { deviceId: string; deviceName: string; command: 'on' | 'off'; kind: 'everyMinutes' | 'at'; everyMinutes?: number; at?: string }): Promise<any> {
    const deviceId = String(rule.deviceId || '').trim();
    if (!deviceId) throw new Error('deviceId is required');
    if (deviceId.includes(':')) {
      // Namespaced id ("<platform>:<nativeId>") — the owning platform must be connected.
      const key = deviceId.split(':')[0];
      const platform = this.smartHomeHub.get(key);
      if (!platform) throw new Error(`Unknown smart home platform "${key}" — pick a device from Smart Home → Devices`);
      if (!platform.isConfigured()) throw new Error(`${platform.label} is not connected — connect it in Smart Home → Connect`);
    } else if (!this.smartThings.isConfigured()) {
      // A bare id is a legacy SmartThings device id from before the multi-platform hub.
      throw new Error('SmartThings is not configured — connect your PAT in Smart Home → Connect, or schedule a device from another platform');
    }
    return this.smartScheduler.add({ ...rule, deviceId });
  }

  async smartScheduleCancel(id: string): Promise<any> {
    return this.smartScheduler.cancel(id);
  }

  async smartStatus(): Promise<{ configured: boolean; tokenMasked: string; deviceCount?: number }> {
    const configured = this.smartThings.isConfigured();
    const masked = this.smartThings.getMaskedToken();
    if (!configured) return { configured, tokenMasked: '' };
    try {
      const devices = await this.smartThings.listDevices();
      return { configured, tokenMasked: masked, deviceCount: devices.length };
    } catch {
      return { configured, tokenMasked: masked };
    }
  }

  async smartSetToken(token: string): Promise<{ ok: boolean; tokenMasked: string; deviceCount: number }> {
    const t = token?.trim() || '';
    if (!t) throw new Error('Token is required — paste your PAT from account.smartthings.com/tokens');
    // Validate before persisting (401/403 bubble as human errors)
    await this.smartThings.validateToken(t);
    this.smartThings.setToken(t);
    const masked = this.smartThings.getMaskedToken();
    const devices = await this.smartThings.listDevices().catch(() => [] as any[]);
    return { ok: true, tokenMasked: masked, deviceCount: Array.isArray(devices) ? devices.length : 0 };
  }

  async smartClearToken(): Promise<{ ok: boolean }> {
    this.smartThings.clearToken();
    return { ok: true };
  }

  // ── Smart Home — multi-platform hub (SmartThings + HA + Hubitat + openHAB + Tuya + Hive + Homey + Apple/Alexa/Google) ──

  async smartPlatforms(): Promise<any> {
    return this.smartHomeHub.catalog();
  }

  async smartConnectPlatform(key: string, token: string, url?: string): Promise<any> {
    const platform = this.smartHomeHub.get(key);
    if (!platform?.setToken) throw new Error(`Platform "${key}" does not support token connect`);
    const res = await platform.setToken(token, url);
    return { ok: true, platform: key, deviceCount: res.deviceCount ?? 0, tokenMasked: res.tokenMasked };
  }

  async smartDisconnectPlatform(key: string): Promise<any> {
    const platform = this.smartHomeHub.get(key);
    if (!platform) throw new Error(`Unknown smart home platform "${key}"`);
    await platform.clearToken?.();
    return { ok: true, platform: key };
  }

  /** Cloud platforms only — build the vendor consent URL the desktop opens. */
  async smartOauthStart(key: string, redirectUri?: string): Promise<any> {
    const platform = this.smartHomeHub.get(key);
    if (!platform?.beginOAuth) throw new Error(`Platform "${key}" does not support OAuth sign-in — paste a token instead`);
    // Default to a loopback on the API port so the vendor can redirect back to
    // us. Mirrors the connector OAuth callback default in ConnectorApi.
    const redirect = redirectUri?.trim() || `http://127.0.0.1:8787/api/smart/platforms/${encodeURIComponent(key)}/oauth/callback`;
    return { platform: key, ...platform.beginOAuth(redirect) };
  }

  /** Exchange the callback code, persist the session, and report the device count. */
  async smartOauthCallback(key: string, code: string, state: string): Promise<any> {
    const platform = this.smartHomeHub.get(key);
    if (!platform?.completeOAuth) throw new Error(`Platform "${key}" does not support OAuth sign-in`);
    if (!code) throw new Error('code is required');
    const res = await platform.completeOAuth(code, state);
    return { platform: key, ...res };
  }

  // ── Carrusel (AI-powered Instagram carousel designer) ──────

  async carruselStart(): Promise<any> {
    const ok = await this.carrusel.start();
    if (!ok) throw new Error('Open Carrusel failed to start — check that `npm install` ran in external/open-carrusel and Node >= 20 is available');
    return this.carrusel.getStatus();
  }

  async carruselStop(): Promise<any> {
    await this.carrusel.stop();
    return { stopped: true };
  }

  async carruselStatus(): Promise<any> {
    return this.carrusel.getStatus();
  }

  async carruselCreate(opts: { name: string; aspectRatio?: string }): Promise<any> {
    return this.carrusel.createCarousel(opts.name, (opts.aspectRatio as '1:1' | '4:5' | '9:16') || '4:5');
  }

  async carruselList(): Promise<any> {
    return this.carrusel.listCarousels();
  }

  async carruselGet(id: string): Promise<any> {
    return this.carrusel.getCarousel(id);
  }

  async carruselAddSlide(opts: { carouselId: string; html: string; note?: string }): Promise<any> {
    return this.carrusel.addSlide(opts.carouselId, opts.html, opts.note);
  }

  async carruselChat(opts: { message: string; carouselId?: string }): Promise<any> {
    const response = await this.carrusel.chat(opts.message, opts.carouselId);
    return { response };
  }

  async carruselExport(id: string): Promise<{ zipBase64: string; carouselId: string }> {
    const zipBuffer = await this.carrusel.exportZip(id);
    return { zipBase64: zipBuffer.toString('base64'), carouselId: id };
  }

  async carruselDelete(id: string): Promise<any> {
    await this.carrusel.deleteCarousel(id);
    return { deleted: id };
  }

  async carruselBrand(): Promise<any> {
    return this.carrusel.getBrand();
  }

  async carruselDuplicate(id: string): Promise<any> {
    return this.carrusel.duplicateCarousel(id);
  }

  // ── Twenty CRM (open-source CRM, Docker Compose + GraphQL) ──

  async twentyStart(): Promise<any> {
    return this.twenty.start();
  }

  async twentyStop(): Promise<any> {
    await this.twenty.stop();
    return { stopped: true };
  }

  async twentyStatus(): Promise<any> {
    return this.twenty.getStatus();
  }

  async twentyGraphql(opts: { query: string; variables?: Record<string, unknown> }): Promise<any> {
    return this.twenty.graphql(opts.query, opts.variables);
  }

  async shutdown(): Promise<void> {
    getLogger().info('Umbra OS shutting down...');
    eventBus.emit('app:shutdown');

    await this.journal.generateDailyJournal().catch(() => {});
    this.topicIndexer.rebuildIndex();
    this.watcher?.stop();
    this.proactive?.stop();
    this.audio.stop();
    this.healer.stop();
    this.streamer?.stop();
    this.shadow?.stop();
    this.awareness?.stopWatching();
    this.meetingCompanion?.stopListening();
    // If the app shuts down mid-meeting, don't leave the cable selected as the mic.
    try {
      const restored = await this.restoreMeetingMic();
      if (restored) getLogger().info('Meeting mic restored on shutdown');
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Could not restore the meeting mic on shutdown');
    }
    this.hotkey?.stop();
    this.pushToTalkHotkey?.stop();
    this.issueWatcher?.stop();
    this.pairing?.cleanup();
    this.p2p?.stop();
    this.pwa?.stop();
    this.deviceClient?.stop();
    this.taskSyncBridge?.stop();
    this.deviceHub?.stop();
    this.repos.close();
    if (this.socialTimer) clearInterval(this.socialTimer);
    if (this.smartTimer) clearInterval(this.smartTimer);
    await this.carrusel.stop();
    await this.twenty.stop();
    await this.fastEngine.stop();
    await this.api.stop();
    await this.desktop2.stop();
    await this.realDesktop?.stop();
    await this.swarm.shutdown();
    await this.displayManager.destroyAll();
    this.memory.close();

    this.initialized = false;
    getLogger().info('Umbra OS shutdown complete');
  }

  get subsystems() {
    return {
      config: this.configManager,
      knowledge: this.knowledge,
      bridge: this.bridge,
      llm: this.llm,
      agent: this.agent,
      consent: this.consent,
      proactive: this.proactive,
      watcher: this.watcher,
      privacy: this.privacy,
      journal: this.journal,
      topicIndexer: this.topicIndexer,
      screenReader: this.screenReader,
      desktop2: this.desktop2,
      realDesktop: this.realDesktop,
      swarm: this.swarm,
      healer: this.healer,
      recall: this.memory,
      vault: this.vault,
      audio: this.audio,
      streamer: this.streamer,
      hud: this.hud,
      pairing: this.pairing,
      p2p: this.p2p,
      pwa: this.pwa,
      deviceRegistry: this.deviceRegistry,
      deviceHub: this.deviceHub,
      deviceClient: this.deviceClient,
      graphify: this.graphify,
      skillRecorder: this.skillRecorder,
      skillRouter: this.skillRouter,
      skillRepos: listSkillRepos(),
      skillContentIndexed: this.skillContent.size,
      mcpRegistry: this.mcpRegistry,
      mcpRouter: this.mcpRouter,
      credVault: this.credVault,
      shadow: this.shadow,
      awareness: this.awareness,
      meetings: this.meetings,
      meetingCompanion: this.meetingCompanion,
      billing: this.billing,
      windowsTts: this.windowsTts,
      vibeVoiceTts: this.vibeVoiceTts,
      voiceboxClient: this.voiceboxClient,
      telnyx: this.telnyx,
      dockerDaemon: this.dockerDaemon,
      metering: this.metering,
      modelRouter: this.modelRouter,
      openmontage: this.openmontage,
      imageGen: this.imageGen,
      speechToText: this.speechToText,
    };
  }
}

async function main(): Promise<void> {
  const os = new UmbraOS();
  await os.initialize();

  process.on('SIGINT', async () => {
    await os.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await os.shutdown();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    try { getLogger().error({ err: (err as Error).message, stack: (err as Error).stack }, 'uncaughtException — keeping process alive'); } catch { console.error('uncaughtException', err); }
  });
  process.on('unhandledRejection', (reason) => {
    try { getLogger().error({ reason: String(reason) }, 'unhandledRejection — keeping process alive'); } catch { console.error('unhandledRejection', reason); }
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export default UmbraOS;
