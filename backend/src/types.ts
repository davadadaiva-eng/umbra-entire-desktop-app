export type ModelProvider = 'ollama' | 'openai' | 'anthropic' | 'openai-compatible';

export interface ModelConfig {
  provider: ModelProvider;
  reasoning: string;
  vision: string;
  fast: string;
  embedding?: string;
}

export interface ProviderConfig {
  endpoint?: string;
  apiKey?: string;
}

export interface RepoConfig {
  name: string;
  path: string;
}

export type PlanTier = 'free' | 'byok' | 'pro' | 'ultimate' | 'enterprise';

/**
 * One tier of the model-routing ladder. `*PerM` fields are USD per 1M tokens.
 */
export interface ModelTierConfig {
  provider: ModelProvider;
  model: string;
  /** Optional per-slot endpoint override (e.g. OpenRouter for the free tier). */
  endpoint?: string;
  /** USD per 1M input tokens (cache miss). */
  inputPerM: number;
  /** USD per 1M input tokens (cache hit). */
  cacheHitPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

/**
 * The model slots the router can select between. Every slot is a distinct
 * model; the router maps (role, task) → slot and spills over to `free`
 * whenever a hosted slot's quota is exhausted.
 */
export type RoutingTier = 'free' | 'fast' | 'reasoning' | 'frontend' | 'difficult';

/**
 * Tiered model routing + rate limits. Optional so legacy configs keep working;
 * defaults are applied at runtime by the ModelRouter.
 */
export interface RoutingConfig {
  enabled: boolean;
  /** Assumed cache-hit ratio for cost estimation (0-1). Prompt caching. */
  cacheHitRatio: number;
  /** Compress input context before calls (Graphify). */
  graphify: boolean;
  /** Cap/densify outputs to the plan max (Caveman). */
  caveman: boolean;
  /** Free models — the spillover target and the free-plan default (cloud free models). */
  free: ModelTierConfig;
  /** Day-to-day quick/vision work (DeepSeek V4 Flash). */
  fast: ModelTierConfig;
  /** Day-to-day agentic/reasoning work (DeepSeek-R1). */
  reasoning: ModelTierConfig;
  /** Frontend / design work (Muse Spark 1.2). */
  frontend: ModelTierConfig;
  /** Difficult tasks (Claude Sonnet 5, hard-capped). */
  difficult: ModelTierConfig;
}

export interface McpConnectorConfig {
  id: string;
  name: string;
  category: string;
  baseUrl: string;
  authType: 'none' | 'bearer' | 'apiKey' | 'oauth';
  apiKeyHeader?: string;
  credentialKey?: string;
  /** Remote MCP tool name for this connector (e.g. DeepWiki's `ask_question`).
   *  Defaults to `invoke` for generic/REST connectors. */
  tool?: string;
  enabled: boolean;
}

/**
 * Operator-registered OAuth client credentials for an `oauth` connector.
 * The client id/secret belong to the Umbra deployment (registered with the
 * provider's developer console); the end user authorizes their own account.
 */
export interface McpOauthClientConfig {
  clientId: string;
  clientSecret?: string;
  /** Override the provider's authorize/token endpoints (required for unknown providers). */
  authorizeUrl?: string;
  tokenUrl?: string;
  /** Override the provider's default scopes. */
  scopes?: string[];
}

export interface UmbraConfig {
  provider: ModelProvider;
  models: ModelConfig;
  /** OpenRouter API key — convenience field that maps to openaiCompatible.apiKey for OpenRouter-backed setups. */
  openrouterApiKey?: string;
  /** Skip all consent prompts — tasks run immediately without y/n approval. Default: true. */
  autoApprove?: boolean;
  ollama?: ProviderConfig;
  openai?: ProviderConfig;
  anthropic?: ProviderConfig;
  openaiCompatible?: ProviderConfig & { endpoint: string };
  /**
   * LLM boot state, resolved at startup by the health check in
   * `UmbraOS.initialize()`. `disabled: true` means the configured provider is
   * unreachable (or was switched off via `UMBRA_LLM_PROVIDER=none`) — Umbra
   * keeps running and reports a helpful message instead of failing every task
   * with an opaque provider error. Never persisted; recomputed on every boot.
   */
  llm?: {
    disabled: boolean;
    /** Human-readable explanation surfaced in /api/status and the UI. */
    reason?: string;
    /** Provider in effect (may differ from `provider` when disabled). */
    provider?: string;
    checkedAt?: number;
  };
  hotkeys: {
    overlay: string;
    pause: string;
    togglePreview: string;
  };
  workspace: {
    maxSwarmDisplays: number;
    displayWidth: number;
    displayHeight: number;
    displayFps: number;
    cpuLimit: number;
    gpuLimit: number;
  };
  paths: {
    dataDir: string;
    knowledgeDir: string;
    recallDb: string;
    vaultDir: string;
    logsDir: string;
  };
  audio: {
    enabled: boolean;
    gestureCooldownMs: number;
  };
  realDesktop: {
    chromePath: string;
    cdpPort: number;
    windowWidth: number;
    windowHeight: number;
    enabled: boolean;
  };
  repos: RepoConfig[];
  /**
   * GitHub issue → task loop: watch repos, dispatch new open issues as agent
   * tasks (routed through CompanionRegistry), and post the completed summary
   * back as an issue comment. Optional — absent = disabled.
   */
  github?: {
    enabled: boolean;
    /** Repos to watch (owner/repo, optionally mapped to a local ReposManager repo). */
    repositories: { owner: string; repo: string; localName?: string }[];
    /** Poll interval in ms (default 60_000). */
    pollIntervalMs?: number;
    /** CredentialVault service key holding the GitHub PAT (default 'github'). */
    tokenService?: string;
    /** Only watch issues carrying any of these labels (empty = all open issues). */
    labels?: string[];
    /** Only watch issues assigned to this login (empty = any assignee). */
    assignedTo?: string;
    /** Ask the user before dispatching each issue (default true). */
    consentRequired?: boolean;
    /** Post the task summary back as a comment (default true). */
    commentResults?: boolean;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    prettyPrint: boolean;
  };
  p2p: {
    enabled: boolean;
    webPort: number;
    signalingPort: number;
    stunServers: string[];
    /** Optional TURN relay URLs (`turn:host:port`) for NAT-traversal fallback. */
    turnServers?: string[];
    relayFps: number;
    /**
     * Embed the Rust mesh daemon (umbra-meshd, mesh/) as an optional P2P
     * transport: zero-knowledge identity + QR pairing + paired-device store.
     * No-op when the binary is not built (reports running:false).
     */
    meshEnabled?: boolean;
  };
  /**
   * Device mesh: an always-on hub (usually the cloud) that every device
   * stays connected to. QR/link joins issue a long-lived token; clients
   * auto-reconnect so the mesh survives restarts and network drops.
   */
  devices: {
    enabled: boolean;
    /** WebSocket port this node's DeviceHub listens on. */
    hubPort: number;
    /** Remote hub to connect to as a client (empty = this node is the hub). */
    hubUrl: string;
    /** Long-lived token issued by the remote hub after join (persisted). */
    hubToken?: string;
    /** Device id assigned by the remote hub after join (persisted). */
    hubDeviceId?: string;
    name: string;
    role: 'desktop' | 'phone' | 'server' | 'other';
  };
  plan: {
    tier: PlanTier;
    apiCreditPool: number;
    imagesMonthly: number;
    videoMonthly: number;
    /** Tiered model routing + rate limits (defaults applied at runtime). */
    routing?: RoutingConfig;
    /**
     * Allow in-flight tasks to resume on the cloud node after a restart.
     * Paid feature: activation flips this on; the free plan never resumes
     * on the cloud (the desktop always resumes its own local queue).
     */
    cloudContinuation?: boolean;
  };
  graphify: {
    enabled: boolean;
    maxContextTokens: number;
    summaryTokens: number;
    chunkTokens: number;
  };
  compiler: {
    enabled: boolean;
    backend: 'none' | 'node' | 'tcc' | 'clang';
    outputDir: string;
  };
  mcp: {
    enabled: boolean;
    connectors: McpConnectorConfig[];
    /**
     * Per-provider OAuth client credentials, keyed by the connector's
     * credentialKey (e.g. 'gmail', 'microsoft-365', 'dropbox'). Unknown
     * providers need authorizeUrl + tokenUrl supplied here as well.
     */
    oauthClients?: Record<string, McpOauthClientConfig>;
  };
  shadow: {
    enabled: boolean;
    capture: 'dxgi' | 'gdi';
    fps: number;
  };
  meeting: {
    enabled: boolean;
    stt: 'none' | 'local';
    /** Meeting TTS: 'none' | 'local' (Windows SAPI) | 'vibevoice' | 'voicebox' (voice cloning) | 'piper' (Piper TTS). */
    tts: 'none' | 'local' | 'vibevoice' | 'voicebox' | 'piper';
    /** Capture system audio (the call) via WASAPI loopback for live transcription. */
    loopbackEnabled: boolean;
    /** Seconds of meeting audio captured per transcription chunk. */
    chunkSec: number;
    /** Detect + auto-execute orders spoken in the meeting ("Hey Umbra, ..."). */
    ordersEnabled?: boolean;
    /** Allow screen-share actions (share/stop) during a meeting. */
    screenShare?: boolean;
    /**
     * Route Umbra's spoken replies to a virtual audio cable (VB-Cable) so call
     * participants hear them, instead of only the local speakers. 'none' =
     * local speakers; 'auto' = auto-detect the cable; or a device name/id.
     */
    audioCable?: 'none' | 'auto' | string;
    /** When true, joining a meeting sets the default mic to the cable's output side so the call picks up Umbra automatically. */
    routeMic?: boolean;
    /**
     * Drive the *native* Zoom/Teams desktop app (keyboard shortcuts via
     * SendInput) instead of / in addition to browser DOM automation.
     * 'none' = browser only; 'auto' = detect a running app; or pin the app.
     */
    nativeApp?: 'none' | 'auto' | 'zoom' | 'teams';
  };
  /** Screen awareness: Umbra sees the live screen + cursor and answers questions about it. */
  awareness: {
    enabled: boolean;
    /** Continuously watch the screen + cursor (defaults true on desktop). */
    watch?: boolean;
    /** Milliseconds between live screen/cursor samples. */
    watchIntervalMs?: number;
    /** Track the cursor trail so answers know what you are pointing at. */
    followCursor?: boolean;
  };
  telco: {
    enabled: boolean;
    provider: 'telnyx';
    fromNumber: string;
    /** Optional Telnyx messaging profile id for SMS. */
    messagingProfileId?: string;
  };
  docker: {
    enabled: boolean;
    socketPath: string;
    defaultCpus: number;
    defaultMemoryMb: number;
  };
  /** Paid-plan billing (Stripe checkout + webhook). Secrets live in config.json (git-ignored), never in code. */
  billing: {
    enabled?: boolean;
    provider: 'stripe';
    /** Stripe secret API key (sk_...). */
    secretKey: string;
    /** Stripe webhook signing secret (whsec_...). */
    webhookSecret: string;
    /** Stripe price id per plan tier (e.g. { pro: 'price_...', ultimate: 'price_...' }). */
    priceIds: Record<string, string>;
    /** Public base URL for success/cancel redirects (defaults to UMBRA_PUBLIC_URL). */
    publicUrl: string;
  };
  /** Cloud VPS provisioning — on-demand Hetzner boxes per paying user. */
  cloud?: {
    enabled: boolean;
    /** Hetzner Cloud API token. */
    hetznerApiToken: string;
    /** Pre-uploaded SSH key name in Hetzner. */
    sshKeyName: string;
    /** Hetzner location (default 'fsn1' = Falkenstein). */
    location?: string;
    /** Docker image to deploy (default 'umbra-os:latest'). */
    umbraImage?: string;
    /** Public URL base for provisioned instances. */
    publicUrl?: string;
  };
  image: {
    enabled: boolean;
    provider: 'huggingface' | 'replicate';
    /** Model id, e.g. black-forest-labs/FLUX.1-schnell (HF) or flux-schnell (Replicate). */
    model: string;
    apiKey: string;
    /** Optional API endpoint override. */
    endpoint?: string;
  };
  /** Voice-to-text (and TTS) — pluggable providers, free/local or cloud. */
  voice: {
    enabled: boolean;
    /**
     * Hold-to-talk hotkey combo (e.g. "Ctrl+Shift+Space") that captures the
     * microphone while held, then transcribes → routes → submits a task and
     * speaks back a confirmation on release. Empty = push-to-talk disabled.
     */
    pushToTalk?: string;
    /**
     * STT backend: 'none' | 'openai' (Whisper API) | 'whisper-local'
     * (a whisper.cpp server, e.g. http://localhost:8080) | 'voicebox'
     * (Voicebox's bundled Whisper via http://127.0.0.1:17493/transcribe).
     */
    sttProvider: 'none' | 'openai' | 'whisper-local' | 'voicebox' | 'faster-whisper';
    /** For 'openai': the transcriptions endpoint. For 'whisper-local': the server base URL. For 'faster-whisper': STT server URL. */
    sttEndpoint: string;
    /** API key for the 'openai' backend (falls back to openai.apiKey). */
    sttApiKey: string;
    /** Whisper model id (e.g. whisper-1, or a whisper.cpp model). */
    sttModel: string;
    /** Default VibeVoice speaker name or id (e.g. 'Carter' or 'en-Carter_man'). */
    vibevoiceVoice?: string;
    /** Default VibeVoice language code (e.g. 'en', 'de', 'fr', 'sp'). */
    vibevoiceLanguage?: string;
    /** VibeVoice model id/path (default microsoft/VibeVoice-Realtime-0.5B). */
    vibevoiceModel?: string;
    /** VibeVoice inference device: 'auto' | 'cuda' | 'mps' | 'cpu'. */
    vibevoiceDevice?: 'auto' | 'cuda' | 'mps' | 'cpu';
    /** Voicebox (jamiepine/voicebox) server URL for cloned-voice TTS. */
    voiceboxUrl?: string;
    /** Default Voicebox profile name/id to speak with. */
    voiceboxProfile?: string;
    /** Default Voicebox TTS engine (qwen | luxtts | chatterbox | kokoro | tada | ...). */
    voiceboxEngine?: string;
    /**
     * Meeting diarization: 'none' | 'vibevoice' (microsoft/VibeVoice-ASR —
     * who/when/what speaker labels, ~17 GB) | 'whisper' (faster-whisper small
     * + ECAPA embeddings, ~520 MB, fully ungated — the lightweight default).
     */
    asrProvider?: 'none' | 'vibevoice' | 'whisper';
    /** VibeVoice-ASR diarization server URL. */
    vibevoiceAsrUrl?: string;
    /** VibeVoice-ASR model id/path (default microsoft/VibeVoice-ASR). */
    vibevoiceAsrModel?: string;
    /** Freeform context/hotwords for diarization (speaker names, jargon, topics). */
    vibevoiceAsrContext?: string;
    /** Whisper-ASR diarization server URL (default http://127.0.0.1:17501). */
    whisperAsrUrl?: string;
    /** faster-whisper model id (default 'small'). */
    whisperAsrModel?: string;
    /** Faster-Whisper STT server URL (default http://127.0.0.1:17510). */
    fasterWhisperUrl?: string;
    /** Default language for faster-whisper STT (default 'it'). */
    fasterWhisperLanguage?: string;
    /** Piper TTS server URL (default http://127.0.0.1:17520). */
    piperUrl?: string;
    /** Default Piper voice model id (default 'it_IT-riccardo-medium'). */
    piperVoice?: string;
    /** Default language for Piper TTS (default 'it'). */
    piperLanguage?: string;
  };
  hermes: {
    enabled: boolean;
    /** Path override for the `hermes` CLI (auto-detected when empty). */
    bin: string;
    /** Max seconds a delegated task may run before it is killed. */
    taskTimeoutMs: number;
    /** Route whole tasks through the built-in reasoning engine when available. */
    autoDelegate: boolean;
  };
  /**
   * Smart Home (Samsung SmartThings) — lets the agent list/control devices
   * (sm_devices / sm_on / sm_off / sm_schedule) and powers /api/smart/*.
   * Optional — absent = disabled.
   */
  smartthings?: {
    enabled: boolean;
    /** Personal access token (account.smartthings.com/tokens). Defaults from UMBRA_SMARTTHINGS_TOKEN. */
    token: string;
    /** API base URL (default https://api.smartthings.com). */
    baseUrl: string;
  };
}

export type TaskStatus = 'pending' | 'planning' | 'executing' | 'healing' | 'completed' | 'failed' | 'cancelled' | 'waiting_input' | 'paused';

/** A single step in a task plan (mirrors TaskPlanner.PlannedStep). */
export interface TaskPlanStep {
  /** Stable id other steps can reference in dependsOn (defaults to `step-<n>`). */
  id?: string;
  description: string;
  action: string;
  params: Record<string, unknown>;
  requiresKnowledge: string[];
  /** Ids of steps that must finish first; absent = may run in parallel. */
  dependsOn?: string[];
}

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  priority: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  assignedSwarmId?: number;
  result?: TaskResult;
  error?: string;
  /** The plan, captured once planning succeeds — enables cross-restart resume. */
  plan?: TaskPlanStep[];
  /** Completed steps (checkpointed after every step). */
  steps?: TaskStep[];
  /** Index of the next plan step to run (== steps.length in the normal flow). */
  completedStepCount?: number;
  /** Consent was already granted for this task (so resume skips re-prompting). */
  consentGranted?: boolean;
  /** Which node last ran this task — 'desktop' or 'cloud'. */
  resumeNode?: 'desktop' | 'cloud';
  /** Optimistic concurrency control version — incremented on each save. */
  version?: number;
  /** SHA-256 hash of input+intent for idempotent task creation. */
  idempotencyKey?: string;
  /** Worker ID that currently holds the lease on this task. */
  leaseOwner?: string;
  /** Lease expiration timestamp (ISO string). */
  leaseDeadline?: string;
}

export interface TaskResult {
  summary: string;
  output: unknown;
  steps: TaskStep[];
  totalTimeMs: number;
}

export interface TaskStep {
  description: string;
  action: string;
  params: Record<string, unknown>;
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt: Date;
}

export interface KnowledgeNode {
  id: string;
  title: string;
  content: string;
  tags: string[];
  links: string[];
  category: KnowledgeCategory;
  updatedAt: Date;
  embedding?: number[];
}

export type KnowledgeCategory =
  | 'social'
  | 'automation'
  | 'tool'
  | 'domain'
  | 'config'
  | 'system'
  | 'workflow';

export interface AuditEntry {
  id: string;
  timestamp: Date;
  action: string;
  target: string;
  params: Record<string, unknown>;
  result: string;
  signature: string;
  previousHash: string;
  swarmId?: number;
}

export interface ActivityEntry {
  id: string;
  taskId: string;
  title: string;
  detail: string;
  status: 'info' | 'success' | 'warning' | 'error';
  timestamp: Date;
}

export interface ActionProposal {
  id: string;
  taskId: string;
  action: string;
  args: Record<string, unknown>;
  hash: string;
  status: 'awaiting_review' | 'approved' | 'denied' | 'expired';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface InputRequest {
  id: string;
  taskId: string;
  question: string;
  options?: string[];
  createdAt: Date;
  answeredAt?: Date;
  answer?: string;
}

export type DisplayStatus = 'idle' | 'allocated' | 'active' | 'error';
export type SwarmTaskType = 'browser' | 'render' | 'scrape' | 'file' | 'generic';
export type SwarmPriority = 'low' | 'normal' | 'high';
