import { ApiServer } from './ApiServer';

const PORT = 20000 + Math.floor(Math.random() * 10000);

function makeDeps() {
  return {
    getStatus: async () => ({ initialized: true, uptimeMs: 1 }),
    submitTask: async (description: string) => `task-${description.length}`,
    getTask: (id: string) => (id === 'missing' ? undefined : { id, status: 'completed' }),
    getActiveTasks: () => [{ id: 'a1', status: 'executing' }],
    executeDesktop2: async (action: string, params: Record<string, unknown>) => `did ${action} ${JSON.stringify(params)}`,
    requestConsent: async () => 'granted',
    getConsentState: () => ({ granted: true, denied: false, askOncePerSession: true }),
    isEmergencyStopArmed: () => false,
    armEmergencyStop: () => undefined,
    disarmEmergencyStop: () => undefined,
    searchKnowledge: async (q: string) => [{ id: 'n1', title: q }],
    getMacros: async () => [],
    getSessions: async () => [],
    getPrivacyStats: async () => ({ masked: 0 }),
    getActivitySummary: async () => ({}),
    getSwarmStatus: async () => ({}),
    getAuditStats: async () => ({}),
    getRepos: async () => [{ name: 'demo', path: 'C:\\demo', exists: true, isGit: true, branch: 'main', lastCommit: 'a1b2c3 init', dirty: 0 }],
    getMcpCatalog: async (opts?: Record<string, unknown>) => ({ count: 2, active: 0, entries: [], total: 2, categories: ['Developer'], ...opts }),
    connectMcp: async (id: string, opts: { baseUrl?: string; apiKey?: string; enabled?: boolean }) => ({ id, ...opts }),
    disconnectMcp: async (id: string) => ({ id, enabled: false, connected: false }),
    beginMcpOauth: async (id: string, redirectUri?: string) => ({ connector: { id, authType: 'oauth' }, authorizeUrl: `https://accounts.example.com/auth?state=s1&redirect_uri=${redirectUri ?? ''}`, state: 's1' }),
    completeMcpOauth: async (code: string, state: string) => (state === 's1' ? { connector: { id: 'gmail' }, connected: true, expiresAt: 123 } : Promise.reject(new Error('Unknown or expired OAuth state'))),
    getMcpOauthStatus: async (id: string) => ({ connected: id === 'gmail', expiresAt: id === 'gmail' ? 123 : undefined }),
    refreshMcpOauth: async (id: string) => ({ connected: true, id }),
    syncExternalConnectors: async () => ({ registered: 3, sources: ['smithery'], errors: [] }),
    syncExternalSources: async (opts?: { maxPerSource?: number }) => ({ registered: 25, sources: ['smithery', 'mcp-registry'], maxPerSource: opts?.maxPerSource ?? 0, errors: [] }),
    getMeshStatus: async () => ({ running: true, paired_devices: 1 }),
    meshPair: async (ttl = 120) => ({ deviceId: 'mesh-1', exp: Date.now() + ttl * 1000 }),
    meshPairDemo: async () => ({ ok: true, match: true }),
    meshRevoke: async (deviceId: string) => ({ ok: true, deviceId }),
    getPlanUsage: async () => ({
      plan: 'pro',
      planName: 'Pro',
      monthlyPriceUsd: 19.99,
      budget: { monthlyBudgetUsd: 5, spentUsd: 0.5, remainingUsd: 4.5, slotBudgets: { fast: 1 }, spentBySlot: { fast: 0.2 } },
      metering: { tokensUsed: 1000, tokensLimit: 10000000 },
    }),
    getModelStatus: async () => ({
      provider: 'ollama',
      plan: 'pro',
      monthlyPriceUsd: 19.99,
      budget: { monthlyBudgetUsd: 5, spentUsd: 0.5, remainingUsd: 4.5, slotBudgets: { fast: 1, reasoning: 1, frontend: 1, difficult: 2 }, spentBySlot: { fast: 0.2, reasoning: 0.2, frontend: 0, difficult: 0.1 } },
      routing: { enabled: true, optimizations: { promptCaching: true, cacheHitRatio: 0.85, graphify: true, caveman: true }, maxOutputTokens: 800, tiers: {} },
      plans: [{ tier: 'pro', name: 'Pro', priceUsd: 19.99, budgetUsd: 5 }],
    }),
    testLlm: async () => ({ ok: true, model: 'test-fast', tokens: 30, latencyMs: 5 }),
    configureProvider: async (patch: Record<string, unknown>) => ({ applied: patch }),
    activatePlan: async (tier: string, tenantId?: string) => ({ plan: tier, ...(tenantId ? { tenant: tenantId } : {}), budget: { monthlyBudgetUsd: 5, slotBudgets: { fast: 1, reasoning: 1, frontend: 1, difficult: 2 } } }),
    tenantsList: async () => ([{ id: 't1', name: 'Test user', tier: 'pro', enabled: true, deviceLimit: 1, deviceLimitLabel: 1, createdAt: 'x', updatedAt: 'x' }]),
    tenantsRegister: async (opts: { id: string; name?: string; tier?: string }) => ({ id: opts.id, name: opts.name, tier: opts.tier || 'free', enabled: true, deviceLimit: 1, deviceLimitLabel: 1, createdAt: 'x', updatedAt: 'x' }),
    tenantsActivate: async (id: string, tier: string) => ({ id, tier, enabled: true, deviceLimit: 1, deviceLimitLabel: 1, createdAt: 'x', updatedAt: 'x' }),
    tenantsDisable: async (id: string) => ({ id, enabled: false, tier: 'free', deviceLimit: 1, deviceLimitLabel: 1, createdAt: 'x', updatedAt: 'x' }),
    billingCreateCheckout: async (tier: string) => ({ url: `https://checkout.stripe.com/c/pay/${tier}`, sessionId: `cs_${tier}` }),
    billingHandleWebhook: async (raw: string, sig: string) => ({ event: JSON.parse(raw).type, signature: sig }),
    getProviderConfig: async () => ({ provider: 'openai', keys: { openai: '••••abcd' } }),
    listOpenMontageTools: async () => ({ installed: true, count: 2, tools: [{ name: 'video_compose' }, { name: 'piper_tts' }] }),
    generateImage: async (prompt: string) => ({ imagePath: `/tmp/${prompt.toLowerCase().replace(/\s+/g, '-')}.png`, provider: 'huggingface', model: 'FLUX.1-schnell' }),
    recallMemory: async (query: string) => ({ query, facts: [{ text: 'user prefers dark mode' }], similar: [{ text: 'built the routing engine', distance: 0.1 }], recent: [{ description: 'routing', status: 'completed' }] }),
    rememberMemory: async (text: string) => ({ id: 1, remembered: text, total: 1 }),
    listAudioDevices: async () => ({ available: true, devices: [{ id: '{x}.{y}', name: 'CABLE Input', flow: 'render', isDefault: false }] }),
    setAudioDefault: async (opts: { flow?: string; deviceId?: string }) => ({ result: `set ${opts?.flow ?? 'render'} ${opts?.deviceId}` }),
    delegateHermes: async (description: string, opts?: { provider?: string; model?: string; timeoutMs?: number }) => ({ description, ...opts }),
    generateJournalNow: async () => ({ ok: true }),
    telcoSendSms: async (opts: { to: string; text: string; from?: string }) => ({ ok: true, id: `sms-${opts.to}` }),
    telcoCall: async (opts: { to: string; from?: string; connectionUrl?: string }) => ({ ok: true, id: `call-${opts.to}` }),
    configureTelco: async (patch: { apiKey?: string; fromNumber?: string }) => ({ enabled: true, provider: 'telnyx', fromNumber: patch.fromNumber ?? '+1555', tokenConfigured: !!patch.apiKey }),
    getTelcoStatus: async () => ({ enabled: false, provider: 'telnyx', fromNumber: '', tokenConfigured: false }),
    dockerRun: async (spec: { name: string; image: string }) => ({ name: spec.name, running: true, startedAt: 1 }),
    dockerStop: async (name: string) => name === 'worker-1',
    dockerRemove: async (name: string) => name === 'worker-1',
    dockerList: async () => [{ name: 'worker-1', running: true }],
    exportTaskQueue: () => ({ files: { 'task-1.json': '{"id":"task-1"}' } }),
    importTaskQueue: async (payload: { files?: Record<string, string> }) => ({ imported: Object.keys(payload.files ?? {}).length, resumed: 1 }),
    voiceCommand: async (audio: string, opts?: { target?: string }) => ({ text: 'remind me to ship', dispatch: { taskId: 'task-7', target: opts?.target ?? 'desktop' } }),
    getVoiceStackHealth: async (refresh?: boolean) => ({
      ok: true,
      checkedAt: 123,
      components: [
        { component: 'stt', configured: true, ok: true, status: 'ok' },
        { component: 'tts', configured: true, ok: true, status: 'ok' },
        { component: 'asr', configured: true, ok: true, status: 'ok' },
        { component: 'cable', configured: true, ok: true, status: 'ok' },
        { component: 'loopback', configured: true, ok: true, status: 'ok' },
      ],
      refreshed: refresh === true,
    }),
    meetingMute: async (muted: boolean) => `mic ${muted ? 'muted' : 'unmuted'}`,
    meetingRaiseHand: async (raised: boolean) => `hand ${raised ? 'raised' : 'lowered'}`,
    meetingChat: async (message: string) => `sent: ${message}`,
    transcribeAudio: async (_audio: string) => ({ text: 'hello world', language: 'en' }),
    mcpHandle: async (message: Record<string, unknown>) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'umbra', version: '0.1.0' } } };
      }
      if (message.method === 'tools/list') {
        return { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'communication-slack.invoke', description: 'Connector tool', inputSchema: { type: 'object', properties: {} } }] } };
      }
      if (message.method === 'tools/call') {
        return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'sent' }], isError: false } };
      }
      return null;
    },
  };
}

async function api(path2: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path2}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe('ApiServer', () => {
  let server: ApiServer;

  beforeAll(() => {
    server = new ApiServer(makeDeps() as any, PORT);
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('health', async () => {
    const res = await api('/api/health');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  test('status', async () => {
    const res = await api('/api/status');
    expect(res.status).toBe(200);
    expect(res.json.initialized).toBe(true);
  });

  test('consent get', async () => {
    const res = await api('/api/consent');
    expect(res.status).toBe(200);
    expect(res.json.emergencyStopArmed).toBe(false);
  });

  test('consent request', async () => {
    const res = await api('/api/consent', 'POST', { action: 'request', reason: 'test' });
    expect(res.status).toBe(200);
    expect(res.json.result).toBe('granted');
  });

  test('consent unknown action returns 500', async () => {
    const res = await api('/api/consent', 'POST', { action: 'nope' });
    expect(res.status).toBe(500);
  });

  test('task submit and fetch', async () => {
    const created = await api('/api/task', 'POST', { description: 'hello' });
    expect(created.status).toBe(200);
    expect(created.json.taskId).toBe('task-5');

    const fetched = await api('/api/task/task-5');
    expect(fetched.json.task.status).toBe('completed');
  });

  test('task missing returns 500', async () => {
    const res = await api('/api/task/missing');
    expect(res.status).toBe(500);
  });

  test('task requires description', async () => {
    const res = await api('/api/task', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('desktop2 action', async () => {
    const res = await api('/api/desktop2/action', 'POST', { action: 'navigate', params: { url: 'x' } });
    expect(res.status).toBe(200);
    expect(res.json.result).toContain('navigate');
  });

  test('repos list', async () => {
    const res = await api('/api/repos');
    expect(res.status).toBe(200);
    expect(res.json.repos).toHaveLength(1);
    expect(res.json.repos[0].branch).toBe('main');
  });

  test('audio devices list', async () => {
    const res = await api('/api/audio/devices');
    expect(res.status).toBe(200);
    expect(res.json.audio.available).toBe(true);
    expect(res.json.audio.devices[0].name).toBe('CABLE Input');
  });

  test('audio set-default requires deviceId', async () => {
    const res = await api('/api/audio/set-default', 'POST', { flow: 'render' });
    expect(res.status).toBe(500);
  });

  test('audio set-default', async () => {
    const res = await api('/api/audio/set-default', 'POST', { flow: 'capture', deviceId: '{x}.{out}' });
    expect(res.status).toBe(200);
    expect(res.json.result).toBe('set capture {x}.{out}');
  });

  test('mcp catalog', async () => {
    const res = await api('/api/mcp/catalog');
    expect(res.status).toBe(200);
    expect(res.json.catalog.count).toBe(2);
    expect(res.json.catalog.active).toBe(0);
  });

  test('mcp connect requires id', async () => {
    const res = await api('/api/mcp/connect', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('mcp connect applies options', async () => {
    const res = await api('/api/mcp/connect', 'POST', { id: 'stripe', baseUrl: 'https://x', enabled: true });
    expect(res.status).toBe(200);
    expect(res.json.connector.id).toBe('stripe');
    expect(res.json.connector.enabled).toBe(true);
  });

  test('mcp sync invokes external registry sync', async () => {
    const res = await api('/api/mcp/sync', 'POST', { maxPerSource: 5 });
    expect(res.status).toBe(200);
    expect(res.json.sync.registered).toBe(3);
    expect(res.json.sync.sources).toContain('smithery');
  });

  test('mcp oauth start requires an id and returns an authorize URL', async () => {
    const missing = await api('/api/mcp/oauth/start', 'POST', {});
    expect(missing.status).toBe(500);
    const res = await api('/api/mcp/oauth/start', 'POST', { id: 'gmail' });
    expect(res.status).toBe(200);
    expect(res.json.oauth.authorizeUrl).toContain('accounts.example.com');
    expect(res.json.oauth.state).toBe('s1');
  });

  test('mcp oauth callback completes with code + state', async () => {
    const res = await api('/api/mcp/oauth/callback?code=abc&state=s1');
    expect(res.status).toBe(200);
    expect(res.json.oauth.connected).toBe(true);
    expect(res.json.oauth.connector.id).toBe('gmail');
  });

  test('mcp oauth callback rejects a bad state', async () => {
    const res = await api('/api/mcp/oauth/callback?code=abc&state=bogus');
    expect(res.status).toBe(500);
  });

  test('mcp oauth status is masked and keyed by connector id', async () => {
    const res = await api('/api/mcp/oauth/status?id=gmail');
    expect(res.status).toBe(200);
    expect(res.json.oauth.connected).toBe(true);
    expect(res.json.oauth).not.toHaveProperty('accessToken');
  });

  test('mcp oauth refresh posts the connector id', async () => {
    const res = await api('/api/mcp/oauth/refresh', 'POST', { id: 'gmail' });
    expect(res.status).toBe(200);
    expect(res.json.oauth.connected).toBe(true);
  });

  test('llm models returns budget + routing status', async () => {
    const res = await api('/api/llm/models');
    expect(res.status).toBe(200);
    expect(res.json.plan).toBe('pro');
    expect(res.json.monthlyPriceUsd).toBe(19.99);
    expect(res.json.budget.monthlyBudgetUsd).toBe(5);
    expect(res.json.budget.slotBudgets.difficult).toBe(2);
    expect(res.json.budget.slotBudgets.fast).toBe(1);
    expect(res.json.routing.optimizations.cacheHitRatio).toBe(0.85);
    expect(res.json.routing.optimizations.graphify).toBe(true);
    expect(res.json.routing.maxOutputTokens).toBe(800);
  });

  test('llm test runs a live validation call', async () => {
    const res = await api('/api/llm/test', 'POST');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.model).toBe('test-fast');
  });

  test('provider config get masks keys', async () => {
    const res = await api('/api/config/provider');
    expect(res.status).toBe(200);
    expect(res.json.keys.openai).toBe('••••abcd');
  });

  test('provider config set applies patch', async () => {
    const res = await api('/api/config/provider', 'POST', { provider: 'openai', apiKey: 'sk-123', tier: 'pro' });
    expect(res.status).toBe(200);
    expect(res.json.applied.provider).toBe('openai');
    expect(res.json.applied.apiKey).toBe('sk-123');
  });

  test('billing checkout returns a Stripe hosted URL for the tier', async () => {
    const res = await api('/api/billing/checkout?tier=pro');
    expect(res.status).toBe(200);
    expect(res.json.checkout.url).toContain('checkout.stripe.com');
    expect(res.json.checkout.sessionId).toBe('cs_pro');
  });

  test('billing checkout requires a tier', async () => {
    const res = await api('/api/billing/checkout');
    expect(res.status).toBe(500);
  });

  test('billing webhook passes the raw body + signature to the handler', async () => {
    const res = await api('/api/billing/webhook', 'POST', {
      type: 'checkout.session.completed',
      data: { object: { metadata: { tier: 'pro' } } },
    }, { 'stripe-signature': 't=1700000000,v1=abc123' });
    expect(res.status).toBe(200);
    expect(res.json.event).toBe('checkout.session.completed');
    expect(res.json.signature).toBe('t=1700000000,v1=abc123');
  });

  test('plan activate assigns the token budget after payment', async () => {
    const res = await api('/api/plan/activate', 'POST', { tier: 'pro' });
    expect(res.status).toBe(200);
    expect(res.json.plan).toBe('pro');
    expect(res.json.budget.monthlyBudgetUsd).toBe(5);
    expect(res.json.budget.slotBudgets.difficult).toBe(2);
  });

  test('plan activate requires a tier', async () => {
    const res = await api('/api/plan/activate', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('plan activate with a tenant scopes the activation to that tenant', async () => {
    const res = await api('/api/plan/activate', 'POST', { tier: 'ultimate', tenant: 'cust_123' });
    expect(res.status).toBe(200);
    expect(res.json.tenant).toBe('cust_123');
    expect(res.json.plan).toBe('ultimate');
  });

  test('plan usage accepts a tenant filter', async () => {
    const res = await api('/api/plan/usage?tenant=cust_123');
    expect(res.status).toBe(200);
    expect(res.json.plan).toBe('pro');
  });

  test('tenants list returns every registered tenant', async () => {
    const res = await api('/api/tenants');
    expect(res.status).toBe(200);
    expect(res.json.tenants.length).toBe(1);
    expect(res.json.tenants[0].id).toBe('t1');
  });

  test('tenants register creates a tenant with the given plan', async () => {
    const res = await api('/api/tenants/register', 'POST', { id: 'cust_42', name: 'Acme', tier: 'ultimate' });
    expect(res.status).toBe(200);
    expect(res.json.tenant.id).toBe('cust_42');
    expect(res.json.tenant.tier).toBe('ultimate');
  });

  test('tenants register rejects a missing id', async () => {
    const res = await api('/api/tenants/register', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('tenants activate switches one tenant plan', async () => {
    const res = await api('/api/tenants/activate', 'POST', { id: 'cust_42', tier: 'pro' });
    expect(res.status).toBe(200);
    expect(res.json.tenant.tier).toBe('pro');
  });

  test('tenants disable drops the tenant back to the node default budget', async () => {
    const res = await api('/api/tenants/disable', 'POST', { id: 'cust_42' });
    expect(res.status).toBe(200);
    expect(res.json.tenant.enabled).toBe(false);
  });

  test('mcp import-registry bulk-loads connectors from every registry source', async () => {
    const res = await api('/api/mcp/import-registry', 'POST', { maxPerSource: 50 });
    expect(res.status).toBe(200);
    expect(res.json.result.registered).toBe(25);
    expect(res.json.result.sources).toContain('mcp-registry');
    expect(res.json.result.maxPerSource).toBe(50);
  });

  test('openmontage tools lists the registry', async () => {
    const res = await api('/api/openmontage/tools');
    expect(res.status).toBe(200);
    expect(res.json.openmontage.installed).toBe(true);
    expect(res.json.openmontage.count).toBe(2);
  });

  test('image generate dispatches Flux Schnell', async () => {
    const res = await api('/api/image/generate', 'POST', { prompt: 'a neon fox', width: 1024, height: 1024 });
    expect(res.status).toBe(200);
    expect(res.json.image.model).toBe('FLUX.1-schnell');
    expect(res.json.image.imagePath).toContain('a-neon-fox');
  });

  test('image generate requires a prompt', async () => {
    const res = await api('/api/image/generate', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('memory recall returns past sessions + user facts', async () => {
    const res = await api('/api/memory/recall?q=routing');
    expect(res.status).toBe(200);
    expect(res.json.facts[0].text).toBe('user prefers dark mode');
    expect(res.json.similar[0].text).toBe('built the routing engine');
    expect(res.json.recent[0].status).toBe('completed');
  });

  test('memory remember stores a permanent user fact', async () => {
    const res = await api('/api/memory/remember', 'POST', { text: 'my name is Alex' });
    expect(res.status).toBe(200);
    expect(res.json.remembered).toBe('my name is Alex');
    expect(res.json.total).toBe(1);
  });

  test('memory remember requires text', async () => {
    const res = await api('/api/memory/remember', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('agent delegate requires description', async () => {
    const res = await api('/api/agent/delegate', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('agent delegate hands off to hermes', async () => {
    const res = await api('/api/agent/delegate', 'POST', { description: 'Summarize the repo', model: 'openrouter:deepseek/deepseek-r1' });
    expect(res.status).toBe(200);
    expect(res.json.output.description).toBe('Summarize the repo');
    expect(res.json.output.model).toBe('openrouter:deepseek/deepseek-r1');
  });

  test('unknown route returns 404', async () => {
    const res = await api('/api/does-not-exist');
    expect(res.status).toBe(404);
  });

  test('invalid json returns a structured 400', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toContain('Invalid JSON body');
    expect(json.code).toBe('BAD_REQUEST');
  });

  test('a non-object json body returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[1,2,3]',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('BAD_REQUEST');
  });

  test('mcp initialize handshake', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe('2025-03-26');
    expect(json.result.serverInfo.name).toBe('umbra');
  });

  test('mcp tools/list returns registered connectors', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.tools).toContainEqual(expect.objectContaining({ name: 'communication-slack.invoke' }));
  });

  test('mcp tools/call dispatches a connector', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'communication-slack.invoke', arguments: { channel: '#general', text: 'hi' } } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result.content[0].text).toBe('sent');
    expect(json.result.isError).toBe(false);
  });

  test('mcp notifications answer 202 with no body', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
  });

  test('mcp catalog supports query filtering + pagination', async () => {
    const res = await api('/api/mcp/catalog?q=slack&category=Developer&limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(res.json.catalog.q).toBe('slack');
    expect(res.json.catalog.category).toBe('Developer');
    expect(res.json.catalog.limit).toBe(10);
  });

  test('mcp connectors lists only enabled ones', async () => {
    const res = await api('/api/mcp/connectors');
    expect(res.status).toBe(200);
    expect(res.json.connectors.enabled).toBe(true);
  });

  test('mcp disconnect requires an id', async () => {
    const res = await api('/api/mcp/disconnect', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('mcp disconnect disables a connector', async () => {
    const res = await api('/api/mcp/disconnect', 'POST', { id: 'communication-slack' });
    expect(res.status).toBe(200);
    expect(res.json.connector.enabled).toBe(false);
  });

  test('mesh status reports the daemon', async () => {
    const res = await api('/api/mesh/status');
    expect(res.status).toBe(200);
    expect(res.json.running).toBe(true);
    expect(res.json.paired_devices).toBe(1);
  });

  test('mesh pair creates a pairing payload', async () => {
    const res = await api('/api/mesh/pair', 'POST', { ttl: 60 });
    expect(res.status).toBe(200);
    expect(res.json.pair.deviceId).toBe('mesh-1');
  });

  test('mesh revoke requires a deviceId', async () => {
    const res = await api('/api/mesh/revoke', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('mesh revoke removes a paired device', async () => {
    const res = await api('/api/mesh/revoke', 'POST', { deviceId: 'mesh-1' });
    expect(res.status).toBe(200);
    expect(res.json.revoked.ok).toBe(true);
  });

  test('voice command transcribes and dispatches a task', async () => {
    const res = await api('/api/voice/command', 'POST', { audio: 'QUJD', target: 'local' });
    expect(res.status).toBe(200);
    expect(res.json.command.text).toBe('remind me to ship');
    expect(res.json.command.dispatch.target).toBe('local');
  });

  test('voice command requires audio', async () => {
    const res = await api('/api/voice/command', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('meeting mute toggles the mic', async () => {
    const res = await api('/api/meeting/mute', 'POST', { muted: true });
    expect(res.status).toBe(200);
    expect(res.json.result).toBe('mic muted');
  });

  test('meeting raise-hand toggles the hand', async () => {
    const res = await api('/api/meeting/raise-hand', 'POST', { raised: true });
    expect(res.status).toBe(200);
    expect(res.json.result).toBe('hand raised');
  });

  test('meeting chat requires a message', async () => {
    const res = await api('/api/meeting/chat', 'POST', {});
    expect(res.status).toBe(500);
  });

  test('meeting chat sends a message', async () => {
    const res = await api('/api/meeting/chat', 'POST', { message: 'brb' });
    expect(res.status).toBe(200);
    expect(res.json.result).toBe('sent: brb');
  });

  test('plan usage returns the spend dashboard', async () => {
    const res = await api('/api/plan/usage');
    expect(res.status).toBe(200);
    expect(res.json.plan).toBe('pro');
    expect(res.json.budget.remainingUsd).toBe(4.5);
    expect(res.json.metering.tokensLimit).toBe(10000000);
  });

  test('voice health returns the cached stack report', async () => {
    const res = await api('/api/voice/health');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.components).toHaveLength(5);
  });

  test('voice health refresh re-runs the probes', async () => {
    const res = await api('/api/voice/health?refresh=1');
    expect(res.status).toBe(200);
    expect(res.json.refreshed).toBe(true);
  });

  test('telco sms requires to and text', async () => {
    const res = await api('/api/telco/sms', 'POST', { to: '+1555' });
    expect(res.status).toBe(500);
  });

  test('telco sms sends a message', async () => {
    const res = await api('/api/telco/sms', 'POST', { to: '+1555', text: 'hi' });
    expect(res.status).toBe(200);
    expect(res.json.result.ok).toBe(true);
    expect(res.json.result.id).toBe('sms-+1555');
  });

  test('telco status reports settings without the token', async () => {
    const res = await api('/api/telco/status');
    expect(res.status).toBe(200);
    expect(res.json.enabled).toBe(false);
    expect(res.json.tokenConfigured).toBe(false);
  });

  test('telco configure persists key + number', async () => {
    const res = await api('/api/telco/configure', 'POST', { apiKey: 'KEY1234', fromNumber: '+1555', enabled: true });
    expect(res.status).toBe(200);
    expect(res.json.telco.enabled).toBe(true);
    expect(res.json.telco.fromNumber).toBe('+1555');
    expect(res.json.telco.tokenConfigured).toBe(true);
  });

  test('telco call initiates a call', async () => {
    const res = await api('/api/telco/call', 'POST', { to: '+1555', connectionUrl: 'https://example.com/call' });
    expect(res.status).toBe(200);
    expect(res.json.result.id).toBe('call-+1555');
  });

  test('docker run requires name and image', async () => {
    const res = await api('/api/docker/run', 'POST', { name: 'worker-1' });
    expect(res.status).toBe(500);
  });

  test('docker run starts a container', async () => {
    const res = await api('/api/docker/run', 'POST', { name: 'worker-1', image: 'umbra/skill' });
    expect(res.status).toBe(200);
    expect(res.json.container.running).toBe(true);
  });

  test('docker stop/remove/list round-trip', async () => {
    expect((await api('/api/docker/stop', 'POST', { name: 'worker-1' })).json.stopped).toBe(true);
    expect((await api('/api/docker/remove', 'POST', { name: 'worker-1' })).json.removed).toBe(true);
    const list = await api('/api/docker/list');
    expect(list.json.containers).toHaveLength(1);
  });

  test('task-queue export returns durable files', async () => {
    const res = await api('/api/task-queue/export');
    expect(res.status).toBe(200);
    expect(res.json.files['task-1.json']).toContain('task-1');
  });

  test('task-queue import accepts files and resumes', async () => {
    const res = await api('/api/task-queue/import', 'POST', { files: { 'task-2.json': '{"id":"task-2"}', 'task-3.json': '{"id":"task-3"}' } });
    expect(res.status).toBe(200);
    expect(res.json.sync.imported).toBe(2);
    expect(res.json.sync.resumed).toBe(1);
  });
});
