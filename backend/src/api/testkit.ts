/**
 * TEST-ONLY dependency fixtures for the ApiServer suites.
 *
 * Not imported by any production path. It exists so the four ApiServer test
 * files share one exhaustive `ApiServerDeps` implementation instead of four
 * drifting partial ones.
 *
 * `makeFullDeps()` is typed as `ApiServerDeps`, so adding a member to the
 * interface breaks compilation here — that is the point: it makes a new
 * endpoint's dependency impossible to forget.
 *
 * Every stub returns a distinctive, assertable value so a test can prove the
 * request actually reached the right dependency with the right arguments
 * (rather than just that the route matched).
 */
import { AppError } from './AppError';
import type { ApiServerDeps } from './ApiServer';

export interface FullDeps extends ApiServerDeps {
  /** Test-visible call log, in order. */
  readonly calls: Array<{ fn: string; args: unknown[] }>;
}

/** Status shape mirroring `index.ts :: getApiStatus()` (bridges + credVault). */
export function makeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    initialized: true,
    uptimeMs: 1234,
    consent: { granted: true, denied: false, emergencyStopArmed: false },
    llm: { ok: true, disabled: false, provider: 'ollama', message: 'LLM provider ready' },
    credVault: { locked: false, available: true, message: 'Vault unlocked' },
    hermes: { configured: false, autoDelegate: false },
    execution: { role: 'primary', headless: false, plan: 'pro' },
    devices: { paired: 1 },
    bridges: {
      fastEngine: { available: false, ready: false, fallback: 'Desktop2 / Chrome CDP loop (AgentDesktop)', message: 'BrowserUseBridge not installed' },
      openmontage: { available: false, fallback: 'VideoProducer (Remotion CLI)', message: 'OpenMontage not installed' },
      vibevoice: { available: false, fallback: 'Piper TTS / Whisper ASR', message: 'VibeVoice not installed' },
      social: { available: false, fallback: 'no-op scheduler (logs "not configured")', message: 'Social automation not configured' },
      carrusel: { available: false, fallback: 'none (carousel design unavailable)', message: 'OpenCarrusel not installed' },
      twenty: { available: false, running: false, fallback: 'local SQLite-backed CRM', message: 'Twenty CRM Docker stack not found' },
    },
    ...overrides,
  };
}

/**
 * Every dependency implemented, including the optional ones. Returns an object
 * with a `calls` log for argument assertions.
 */
export function makeFullDeps(overrides: Partial<ApiServerDeps> = {}): FullDeps {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const rec = <T>(fn: string, ret: T) => (...args: unknown[]): T => {
    calls.push({ fn, args });
    return ret;
  };

  const deps: FullDeps = {
    calls,

    // ── Core / task lifecycle ──────────────────────────────────
    getStatus: async () => makeStatus(),
    submitTask: async (description: string, priority?: number, idempotencyKey?: string) => {
      calls.push({ fn: 'submitTask', args: [description, priority, idempotencyKey] });
      return `task-${description.length}`;
    },
    chat: async (message: string, target?: string) => {
      calls.push({ fn: 'chat', args: [message, target] });
      return { taskId: 'task-chat', target: target ?? 'auto' };
    },
    getTask: (id: string) => (id === 'missing' ? undefined : { id, status: 'completed' }),
    getActiveTasks: () => [{ id: 'a1', status: 'executing' }],
    getTaskActivity: async (taskId: string) => [{ taskId, at: 1, message: 'step 1' }],
    cancelTask: async (taskId: string) => { calls.push({ fn: 'cancelTask', args: [taskId] }); return { cancelled: true }; },
    retryTask: async (taskId: string, description?: string) => {
      calls.push({ fn: 'retryTask', args: [taskId, description] });
      return { id: `${taskId}-retry` };
    },
    workerClaim: async (taskId: string, workerId: string) => ({ taskId, workerId, lease: 'l1' }),
    workerHeartbeat: async () => true,
    workerRelease: async () => undefined,
    workerRecover: async (workerId: string) => [{ taskId: 't-recovered', workerId }],

    // ── Action proposals / input requests ───────────────────────
    proposeAction: async (taskId: string, action: string, args: Record<string, unknown>) => {
      calls.push({ fn: 'proposeAction', args: [taskId, action, args] });
      return { id: 'prop-1', taskId, action, args, hash: 'h1' };
    },
    reviewAction: async (proposalId: string, approved: boolean, hash: string) => {
      calls.push({ fn: 'reviewAction', args: [proposalId, approved, hash] });
      return { proposalId, approved, hash, executed: approved };
    },
    getProposal: async (id: string) => ({ id, action: 'delete-file', hash: 'h1' }),
    listProposals: async (taskId: string) => [{ id: 'prop-1', taskId }],
    requestInput: async (taskId: string, question: string, options?: string[]) => ({ id: 'in-1', taskId, question, options }),
    submitInput: async (taskId: string, inputId: string, answer: string) => ({ taskId, inputId, answer }),

    // ── Computer control ────────────────────────────────────────
    executeDesktop2: async (action: string, params: Record<string, unknown>) => `did ${action} ${JSON.stringify(params)}`,
    executeGhost: async (action: string, params: Record<string, unknown>) => `ghost ${action} ${JSON.stringify(params)}`,
    captureGhost: async () => 'iVBORw0KGgo=',
    requestConsent: async (reason: string) => { calls.push({ fn: 'requestConsent', args: [reason] }); return 'granted'; },
    getConsentState: () => ({ granted: true, denied: false, askOncePerSession: true }),
    isEmergencyStopArmed: () => false,
    armEmergencyStop: rec('armEmergencyStop', undefined),
    disarmEmergencyStop: rec('disarmEmergencyStop', undefined),

    // ── Knowledge / memory / observability ──────────────────────
    searchKnowledge: async (q: string) => [{ id: 'n1', title: q }],
    getMacros: async () => [{ name: 'daily-standup' }],
    getSessions: async () => [{ id: 's1' }],
    getPrivacyStats: async () => ({ masked: 3 }),
    getActivitySummary: async () => ({ tasks: 4 }),
    getSwarmStatus: async () => ({ slots: 2, allocated: 1 }),
    getAuditStats: async () => ({ entries: 7 }),
    getRepos: async () => [{ name: 'demo', path: 'C:\\demo', exists: true, isGit: true, branch: 'main', lastCommit: 'a1b2c3 init', dirty: 0 }],

    // ── MCP / connectors ────────────────────────────────────────
    getMcpCatalog: async (opts?: Record<string, unknown>) => ({ count: 2, active: 0, entries: [], total: 2, categories: ['Developer'], ...opts }),
    connectMcp: async (id: string, opts: { baseUrl?: string; apiKey?: string; enabled?: boolean }) => ({ id, ...opts }),
    disconnectMcp: async (id: string) => ({ id, enabled: false, connected: false }),
    beginMcpOauth: async (id: string, redirectUri?: string) => ({ connector: { id, authType: 'oauth' }, authorizeUrl: `https://accounts.example.com/auth?state=s1&redirect_uri=${redirectUri ?? ''}`, state: 's1' }),
    completeMcpOauth: async (code: string, state: string) => {
      if (state !== 's1') throw new Error('Unknown or expired OAuth state');
      return { connector: { id: 'gmail' }, connected: true, expiresAt: 123 };
    },
    getMcpOauthStatus: (id: string) => ({ connected: id === 'gmail', expiresAt: id === 'gmail' ? 123 : undefined }),
    refreshMcpOauth: async (id: string) => ({ connected: true, id }),
    syncExternalConnectors: async () => ({ registered: 3, sources: ['smithery'], errors: [] }),
    syncExternalSources: async (opts?: { maxPerSource?: number }) => ({ registered: 25, sources: ['smithery', 'mcp-registry'], maxPerSource: opts?.maxPerSource ?? 0, errors: [] }),
    listConnectors: async (opts?: Record<string, unknown>) => ({ total: 1, items: [{ id: 'gmail' }], ...opts }),
    getConnector: async (id: string) => ({ id, name: 'Gmail', category: 'Communication', authType: 'oauth' }),
    getConnectorCategories: async () => [{ id: 'communication', name: 'Communication', count: 1 }],
    connectConnector: async (id: string, opts: { apiKey?: string; redirectUri?: string }) => ({ id, connected: true, ...opts }),
    completeConnectorOauth: async (id: string, code: string, state: string) => ({ success: state === 's1', connectorId: id, code, expiresAt: 123 }),
    getConnectorReadiness: (id: string) => ({ connectorId: id, state: 'needs_oauth_app', authType: 'oauth', hasBaseUrl: true, hasTools: true, provider: 'Google', action: 'Authorize' }),
    getConnectorReadinessSummary: () => ({ counts: { ready: 1, needs_oauth_app: 1 }, connectors: [] }),
    getConnectorStatus: async (id: string, userId?: string) => ({ id, userId: userId ?? null, connected: true }),
    disconnectConnectorApi: async (id: string) => ({ id, connected: false }),
    executeConnectorAction: async (connectorId: string, endpoint: string, method: string, payload: Record<string, unknown>, userId?: string) => {
      calls.push({ fn: 'executeConnectorAction', args: [connectorId, endpoint, method, payload, userId] });
      return { status: 200, body: { ok: true, method, endpoint } };
    },
    getRelevantTools: async (query: string, limit?: number) => [{ name: 'gmail.send', query, limit }],
    listToolSchemas: async (opts?: Record<string, unknown>) => {
      calls.push({ fn: 'listToolSchemas', args: [opts] });
      return {
        tools: [{ tool_id: 'curated-gmail.send_message', connector_id: 'curated-gmail', name: 'send_message' }],
        total: 1,
        connectors: 1,
        connection: { 'curated-gmail': { connected: true, status: 'connected' } },
        ...opts,
      };
    },
    getConnectorTools: async (connectorId: string) => {
      calls.push({ fn: 'getConnectorTools', args: [connectorId] });
      return {
        connector: connectorId,
        tools: [{ tool_id: `${connectorId}.send_message`, connector_id: connectorId, name: 'send_message' }],
        connection: { connected: true, status: 'connected' },
      };
    },
    ingestConnectorOpenApi: async (opts: { connectorId: string; specUrl?: string; replace?: boolean }) => {
      calls.push({ fn: 'ingestConnectorOpenApi', args: [opts] });
      return {
        connectorId: opts.connectorId,
        ingested: 12,
        removed: 0,
        total: 61,
        replaced: false,
        catalogMatch: true,
      };
    },
    syncConnectorCatalog: async () => ({ synced: 40 }),
    ensureConnectorTools: async (connectorId: string, opts?: { force?: boolean }) => {
      calls.push({ fn: 'ensureConnectorTools', args: [connectorId, opts] });
      return { connectorId, ingested: 12, alreadyIndexed: false, baseUrl: 'https://api.example.test/v1', source: 'spec' };
    },
    saveConnectorCredential: async (slug: string, clientId: string, clientSecret: string, scopes: string[]) => {
      calls.push({ fn: 'saveConnectorCredential', args: [slug, clientId, clientSecret, scopes] });
      return { slug, saved: true };
    },

    // ── LLM / plan / billing / tenants ──────────────────────────
    getModelStatus: async () => ({ provider: 'ollama', plan: 'pro', budget: { monthlyBudgetUsd: 5 }, routing: { enabled: true } }),
    getPlanUsage: async (tenantId?: string) => ({
      plan: 'pro',
      budget: { monthlyBudgetUsd: 5, remainingUsd: 4.5 },
      metering: { tokensUsed: 1000, tokensLimit: 10000000 },
      ...(tenantId ? { tenant: tenantId } : {}),
    }),
    testLlm: async () => ({ ok: true, model: 'test-fast', tokens: 30, latencyMs: 5 }),
    configureProvider: async (patch: Record<string, unknown>) => ({ applied: patch }),
    activatePlan: async (tier: string, tenantId?: string) => ({ plan: tier, ...(tenantId ? { tenant: tenantId } : {}), budget: { monthlyBudgetUsd: 5 } }),
    billingCreateCheckout: async (tier: string) => ({ url: `https://checkout.stripe.com/c/pay/${tier}`, sessionId: `cs_${tier}` }),
    tenantsList: async () => ([{ id: 't1', name: 'Test user', tier: 'pro', enabled: true, deviceLimit: 1 }]),
    tenantsRegister: async (opts: { id: string; name?: string; tier?: string }) => ({ id: opts.id, name: opts.name, tier: opts.tier || 'free', enabled: true }),
    tenantsActivate: async (id: string, tier: string) => ({ id, tier, enabled: true }),
    tenantsDisable: async (id: string) => ({ id, enabled: false, tier: 'free' }),
    billingHandleWebhook: async (rawBody: string, signature: string) => ({ event: JSON.parse(rawBody).type, signature }),

    // ── Providers / media ───────────────────────────────────────
    getProviderConfig: async () => ({ provider: 'openai', keys: { openai: '••••abcd' } }),
    listOpenMontageTools: async () => ({ installed: true, count: 2, tools: [{ name: 'video_compose' }] }),
    generateImage: async (prompt: string) => ({ imagePath: `/tmp/${prompt.toLowerCase().replace(/\s+/g, '-')}.png`, model: 'FLUX.1-schnell' }),

    // ── Voice ───────────────────────────────────────────────────
    getVoiceStatus: async () => ({ stt: 'whisper', tts: 'piper', degraded: false }),
    getVoiceStackHealth: async (refresh?: boolean) => ({ ok: true, refreshed: refresh === true, components: [{ component: 'stt' }] }),
    transcribeAudio: async (_audio: string, opts?: { format?: string; language?: string }) => ({ text: 'hello world', language: opts?.language ?? 'en' }),
    voiceCommand: async (_audio: string, opts?: { target?: string }) => ({ text: 'remind me to ship', dispatch: { taskId: 'task-7', target: opts?.target ?? 'desktop' } }),
    speakText: async (text: string, opts?: { voice?: string; language?: string; provider?: string; engine?: string }) => ({ spoke: text, ...opts }),
    listTtsVoices: async () => ({ default: 'paola', voices: [{ id: 'paola', name: 'Paola' }] }),

    // ── Memory / screen ─────────────────────────────────────────
    recallMemory: async (query: string) => ({ query, facts: [{ text: 'user prefers dark mode' }], similar: [], recent: [] }),
    rememberMemory: async (text: string) => ({ id: 1, remembered: text, total: 1 }),
    screenAsk: async (question: string, intent?: string) => ({ question, intent: intent ?? 'answer', answer: 'blue' }),
    screenState: async () => ({ width: 1920, height: 1080, watching: false }),
    screenLive: async () => ({ frame: 'AAAA', at: 1 }),
    screenWatch: async (enabled: boolean) => ({ watching: enabled }),

    // ── Meeting ─────────────────────────────────────────────────
    meetingJoin: async (url: string, opts?: { title?: string; topics?: string[] }) => ({ url, ...opts, joined: true }),
    meetingStartListening: async () => ({ listening: true }),
    meetingStatus: async () => ({ active: true, platform: 'zoom' }),
    meetingLeave: async () => ({ left: true }),
    meetingExecute: async (action: string, params: Record<string, unknown>) => ({ action, params }),
    meetingFeedAudio: async (audioBase64: string, format?: string) => ({ bytes: audioBase64.length, format: format ?? 'pcm16' }),
    meetingShare: async (target?: string) => ({ sharing: true, target: target ?? 'screen' }),
    meetingStopShare: async () => ({ sharing: false }),
    meetingOrders: async () => ({ orders: [{ kind: 'summarize' }] }),
    meetingSpeak: async (text: string) => ({ spoke: text }),
    meetingMute: async (muted: boolean) => `mic ${muted ? 'muted' : 'unmuted'}`,
    meetingRaiseHand: async (raised: boolean) => `hand ${raised ? 'raised' : 'lowered'}`,
    meetingChat: async (message: string) => `sent: ${message}`,
    meetingBotJoin: async (meetingUrl: string, platform: string, botName?: string) => ({ meetingUrl, platform, botName: botName ?? 'Umbra' }),
    meetingBotLeave: async () => ({ left: true }),
    meetingBotStatus: async () => ({ state: 'idle' }),
    meetingBotTranscript: async () => ({ segments: [{ text: 'hello', at: 0 }] }),
    meetingBotCommand: async (command: string, args?: Record<string, unknown>) => ({ command, args: args ?? {} }),
    getMeetings: async () => [{ id: 'm1', title: 'Standup' }],
    getMeeting: async (id: string) => ({ id, title: `Meeting ${id}` }),

    // ── Audio ───────────────────────────────────────────────────
    listAudioDevices: async () => ({ available: true, devices: [{ id: '{x}.{y}', name: 'CABLE Input', flow: 'render', isDefault: false }] }),
    setAudioDefault: async (opts: { flow?: string; deviceId?: string }) => ({ result: `set ${opts?.flow ?? 'render'} ${opts?.deviceId}` }),
    startLoopback: async (seconds?: number) => ({ id: 'loop-1', seconds: seconds ?? 5 }),
    stopLoopback: async (id: string) => ({ id, stopped: true }),
    listRecordings: async () => [{ id: 'loop-1', path: 'C:\\rec\\loop-1.wav' }],

    // ── Devices / mesh ──────────────────────────────────────────
    listDevices: async () => [{ id: 'dev-1', name: 'Phone', online: true }],
    createDeviceInvite: async (name: string) => ({ code: 'INVITE-1', name }),
    joinDevice: async (code: string, meta: { name: string; role?: string; capabilities?: string[] }) => ({ code, ...meta, joined: true }),
    revokeDevice: async (deviceId: string) => ({ deviceId, revoked: true }),
    sendToDevice: async (deviceId: string, msg: Record<string, unknown>) => ({ deviceId, sent: true, kind: msg['kind'] ?? null }),
    getMeshStatus: async () => ({ running: true, paired_devices: 1 }),
    meshPair: async (ttl = 120) => ({ deviceId: 'mesh-1', exp: 1000 + ttl * 1000 }),
    meshPairDemo: async () => ({ ok: true, match: true }),
    meshRevoke: async (deviceId: string) => ({ ok: true, deviceId }),

    // ── Delegation / journal / skills / task-queue ──────────────
    delegateHermes: async (description: string, opts?: { provider?: string; model?: string; timeoutMs?: number }) => ({ description, ...opts }),
    generateJournalNow: async () => ({ ok: true }),
    compileHotSkills: async (threshold?: number) => ({ compiled: 2, threshold: threshold ?? 3 }),
    exportTaskQueue: () => ({ files: { 'task-1.json': '{"id":"task-1"}' } }),
    importTaskQueue: async (payload: { files?: Record<string, string> }) => ({ imported: Object.keys(payload.files ?? {}).length, resumed: 1 }),

    // ── Telco ───────────────────────────────────────────────────
    telcoSendSms: async (opts: { to: string; text: string; from?: string }) => ({ ok: true, id: `sms-${opts.to}` }),
    telcoCall: async (opts: { to: string; from?: string; connectionUrl?: string }) => ({ ok: true, id: `call-${opts.to}` }),
    configureTelco: async (patch: { apiKey?: string; fromNumber?: string; messagingProfileId?: string; enabled?: boolean }) => ({
      enabled: patch.enabled ?? false,
      provider: 'telnyx',
      fromNumber: patch.fromNumber ?? '+1555',
      messagingProfileId: patch.messagingProfileId ?? null,
      tokenConfigured: !!patch.apiKey,
    }),
    getTelcoStatus: async () => ({ enabled: false, provider: 'telnyx', fromNumber: '', tokenConfigured: false }),

    // ── Docker ──────────────────────────────────────────────────
    dockerRun: async (spec: { name: string; image: string; command?: string[]; env?: Record<string, string>; memoryLimitMb?: number; cpuQuotaPct?: number }) => ({ running: true, ...spec }),
    dockerStop: async (name: string) => name === 'worker-1',
    dockerRemove: async (name: string) => name === 'worker-1',
    dockerList: async () => [{ name: 'worker-1', running: true }],

    // ── Auth ────────────────────────────────────────────────────
    authSignup: async (email: string, password: string, name: string) => ({ email, name, hasPassword: password.length > 0, token: 'tok-signup' }),
    authLogin: async (email: string, password: string) => ({ email, hasPassword: password.length > 0, token: 'tok-login' }),
    authLoginWithKey: async (apiKey: string) => {
      calls.push({ fn: 'authLoginWithKey', args: [apiKey] });
      if (apiKey !== 'sk-valid') throw new Error('Invalid API key');
      return { id: 'u1', email: 'a@b.c', plan: 'pro' };
    },
    authListDevices: async (apiKey: string) => [{ id: 'd1', name: 'Laptop', apiKey }],
    authPairDevice: async (apiKey: string, name: string, type: string) => {
      calls.push({ fn: 'authPairDevice', args: [apiKey, name, type] });
      return { id: 'd-new', name, type, apiKey };
    },
    authRemoveDevice: async (apiKey: string, deviceId: string) => ({ removed: true, deviceId, apiKey }),
    authGetPlan: async (apiKey: string) => ({ plan: 'pro', apiKey, deviceLimit: 1 }),

    // ── MCP JSON-RPC + Chrome extension ─────────────────────────
    mcpHandle: async (message: Record<string, unknown>) => {
      if (message.method === 'notifications/initialized') return null;
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'umbra', version: '0.1.0' } } };
      }
      return { jsonrpc: '2.0', id: message.id, result: { ok: true } };
    },
    handleChromeTelemetry: async (events: unknown[], sessionId: string, cookieSnapshot: unknown) => {
      calls.push({ fn: 'handleChromeTelemetry', args: [events, sessionId, cookieSnapshot] });
      return { ingested: events.length, sessionId, cookies: (cookieSnapshot as { count?: number })?.count ?? 0 };
    },
    getChromeExtensionStatus: () => ({ connected: true, version: '1.4.0' }),
    getChromeLoginEvents: () => [{ url: 'https://accounts.google.com', provider: 'google' }],
    approveChromeLogin: async (url: string, provider: string, username?: string) => ({ url, provider, username: username ?? null, approved: true }),
    getChromeCookies: async (domain?: string) => [{ domain: domain ?? 'example.com', name: 'sid', value: '***' }],
    getChromeSites: async () => [{ host: 'example.com', visits: 3 }],

    // ── JIT routing / wallet / connectors registry ───────────────
    getSmartRoute: async (userId: string, taskType: string, preferAlt?: boolean) => ({ userId, taskType, preferAlt: !!preferAlt, model: 'fast', slot: 'fast', blocked: false }),
    deductWallet: async (userId: string, model: string, usage: Record<string, unknown>) => ({ userId, model, charged: usage['tokens'] ?? 0 }),
    getWallet: async (userId: string) => ({ userId, balanceUsd: 10 }),
    getConnectedConnectors: () => ([{ id: 'gmail', name: 'Gmail', provider: 'google', connectedAt: 1 }]),
    disconnectConnector: async (connectorId: string) => { calls.push({ fn: 'disconnectConnector', args: [connectorId] }); return true; },
    handleStripeWebhook: async (rawBody: string, signature: string) => ({ event: JSON.parse(rawBody).type, signature, jit: true }),

    // ── Social ──────────────────────────────────────────────────
    socialPost: async (opts: { platform: string; action: string; email: string; text?: string }) => {
      calls.push({ fn: 'socialPost', args: [opts] });
      return { ok: true, platform: opts.platform, action: opts.action, text: opts.text ?? null };
    },
    socialSchedule: async (opts: { platform: string; scheduledAt: number }) => ({ id: 'sched-1', platform: opts.platform, scheduledAt: opts.scheduledAt }),
    socialScheduled: async () => ([{ id: 'sched-1', platform: 'x' }]),
    socialCancelSchedule: async (id: string) => ({ id, cancelled: true }),
    socialStatus: async () => ({ configured: false, platform: 'x' }),

    // ── Smart home ──────────────────────────────────────────────
    smartDevices: async () => [{ id: 'sw-1', name: 'Lamp', switch: 'off' }],
    smartCommand: async (deviceId: string, command: 'on' | 'off') => ({ deviceId, command, status: 'ok' }),
    smartControlByName: async (name: string, command: 'on' | 'off') => ({ name, command, status: 'ok' }),
    smartSchedules: async () => [{ id: 'sch-1', deviceName: 'Lamp' }],
    smartScheduleAdd: async (rule: Record<string, unknown>) => ({ id: 'sch-2', ...rule }),
    smartScheduleCancel: async (id: string) => ({ id, cancelled: true }),
    smartStatus: async () => ({ configured: false, baseUrl: 'https://api.smartthings.com' }),
    smartSetToken: async (token: string) => { calls.push({ fn: 'smartSetToken', args: [token] }); return { configured: true, token: '••••' + token.slice(-4) }; },
    smartClearToken: async () => ({ configured: false }),
    smartPlatforms: async () => ([
      { key: 'smartthings', label: 'Samsung SmartThings', configured: false, connected: false },
      { key: 'homeassistant', label: 'Home Assistant', configured: false, connected: false },
    ]),
    smartConnectPlatform: async (key: string, token: string) => { calls.push({ fn: 'smartConnectPlatform', args: [key, token] }); return { ok: true, platform: key, deviceCount: 3, tokenMasked: '••••' + token.slice(-4) }; },
    smartDisconnectPlatform: async (key: string) => { calls.push({ fn: 'smartDisconnectPlatform', args: [key] }); return { ok: true, platform: key }; },
    smartOauthStart: async (key: string, redirectUri?: string) => { calls.push({ fn: 'smartOauthStart', args: [key, redirectUri] }); return { platform: key, authorizeUrl: `https://example.test/authorize?state=st-${key}`, state: `st-${key}` }; },
    smartOauthCallback: async (key: string, code: string, state: string) => { calls.push({ fn: 'smartOauthCallback', args: [key, code, state] }); return { ok: true, platform: key, deviceCount: 3, tokenMasked: '••••' + code.slice(-4) }; },

    // ── Vault ───────────────────────────────────────────────────
    getVaultEntries: async () => [{ id: 'v1', service: 'github', username: 'alex', hasSecret: true }],
    setVaultEntry: async (entry: { service: string; username?: string; secret: string; id?: string }) => {
      calls.push({ fn: 'setVaultEntry', args: [entry] });
      return { id: entry.id ?? 'v-new', service: entry.service, username: entry.username ?? '', hasSecret: !!entry.secret };
    },
    deleteVaultEntry: async (id: string) => { calls.push({ fn: 'deleteVaultEntry', args: [id] }); return { id }; },

    // ── Carousel ────────────────────────────────────────────────
    carruselStart: async () => ({ running: true, port: 4321 }),
    carruselStop: async () => ({ running: false }),
    carruselStatus: async () => ({ running: true, installed: true }),
    carruselCreate: async (opts: { name: string; aspectRatio?: string }) => ({ id: 'car-1', ...opts }),
    carruselList: async () => [{ id: 'car-1', name: 'Launch' }],
    carruselGet: async (id: string) => ({ id, slides: 3 }),
    carruselAddSlide: async (opts: { carouselId: string; html: string; note?: string }) => ({ carouselId: opts.carouselId, slide: 4, note: opts.note ?? null }),
    carruselChat: async (opts: { message: string; carouselId?: string }) => ({ reply: `designed: ${opts.message}`, carouselId: opts.carouselId ?? null }),
    carruselExport: async (id: string) => ({ zipBase64: 'UEsDBA==', carouselId: id }),
    carruselDelete: async (id: string) => ({ id, deleted: true }),
    carruselBrand: async () => ({ palette: ['#0f172a'], font: 'Inter' }),
    carruselDuplicate: async (id: string) => ({ id: `${id}-copy` }),

    // ── Twenty CRM ──────────────────────────────────────────────
    twentyStart: async () => ({ running: true }),
    twentyStop: async () => ({ running: false }),
    twentyStatus: async () => ({ available: false, running: false, fallback: 'local SQLite-backed CRM' }),
    twentyGraphql: async (opts: { query: string; variables?: Record<string, unknown> }) => {
      calls.push({ fn: 'twentyGraphql', args: [opts] });
      return { data: { people: { totalCount: 1 } }, query: opts.query.slice(0, 12) };
    },

    shutdown: rec('shutdown', undefined),

    ...overrides,
  } as FullDeps;

  return deps;
}

/**
 * Same surface minus every OPTIONAL dependency (cancelTask, retryTask,
 * workerClaim, proposeAction, requestInput, …). Used to prove those routes
 * answer 501 Not Implemented rather than 500.
 */
export function makeMinimalDeps(): ApiServerDeps {
  const full = makeFullDeps();
  const optional: Array<keyof ApiServerDeps> = [
    'getTaskActivity', 'cancelTask', 'retryTask',
    'workerClaim', 'workerHeartbeat', 'workerRelease', 'workerRecover',
    'proposeAction', 'reviewAction', 'getProposal', 'listProposals',
    'requestInput', 'submitInput',
  ];
  const minimal: Record<string, unknown> = { ...(full as unknown as Record<string, unknown>) };
  for (const key of optional) delete minimal[key];
  return minimal as unknown as ApiServerDeps;
}

/** Build a thrower for a given AppError — lets a test pin one route's status. */
export function failWith(message: string, status: 400 | 404 | 413 | 422 | 501 | 503): () => never {
  return () => { throw new AppError(message, status); };
}
