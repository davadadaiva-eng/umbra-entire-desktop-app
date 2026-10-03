import * as http from 'http';
import { URL } from 'url';
import WebSocket from 'ws';
import { eventBus } from '../core/EventBus';
import { getLogger } from '../core/Logger';
import { TenantLedger } from '../core/billing/TenantLedger';
import { McpJsonRpcResponse } from '../core/mcp/McpServerEndpoint';
import { AppError, codeForStatus, isAppError } from './AppError';
import { resolveApiKey } from './apiKey';
import { agentRoutes } from './routes/agent';
import { browserRoutes } from './routes/browsers';
import { actionRoutes } from './routes/actions';
import { computerRoutes } from './routes/computer';

// Re-export sub-routers so existing imports via ApiServer keep working.
export { agentRoutes } from './routes/agent';
export { browserRoutes } from './routes/browsers';
export { actionRoutes } from './routes/actions';
export { computerRoutes } from './routes/computer';
export { AppError, codeForStatus, isAppError } from './AppError';
export { resolveApiKey } from './apiKey';
export * from './validate';

export interface ApiServerDeps {
  getStatus(): Promise<Record<string, unknown>>;
  submitTask(description: string, priority?: number, idempotencyKey?: string): Promise<string>;
  chat(message: string, target?: string): Promise<unknown>;
  getTask(id: string): unknown;
  getActiveTasks(): unknown;
  /** Get activity feed for a task. */
  getTaskActivity?(taskId: string): Promise<unknown>;
  /** Cancel an in-flight task (consent-gated on the executing node). */
  cancelTask?(taskId: string): Promise<unknown>;
  /** Retry a failed/cancelled task (consent-gated on the executing node). */
  retryTask?(taskId: string, description?: string): Promise<unknown>;
  /** Worker lease management for distributed task execution. */
  workerClaim?(taskId: string, workerId: string): Promise<unknown>;
  workerHeartbeat?(taskId: string, workerId: string): Promise<unknown>;
  workerRelease?(taskId: string, workerId: string): Promise<unknown>;
  workerRecover?(workerId: string): Promise<unknown>;
  /** Action proposal review flow. */
  proposeAction?(taskId: string, action: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<unknown>;
  reviewAction?(proposalId: string, approved: boolean, hash: string): Promise<unknown>;
  getProposal?(proposalId: string): Promise<unknown>;
  listProposals?(taskId: string): Promise<unknown>;
  /** Input request for waiting_input pause/resume. */
  requestInput?(taskId: string, question: string, options?: string[]): Promise<unknown>;
  submitInput?(taskId: string, inputId: string, answer: string): Promise<unknown>;
  executeDesktop2(action: string, params: Record<string, unknown>): Promise<string>;
  executeGhost(action: string, params: Record<string, unknown>): Promise<string>;
  captureGhost(): Promise<string | null>;
  requestConsent(reason: string): Promise<string>;
  getConsentState(): Record<string, unknown>;
  isEmergencyStopArmed(): boolean;
  armEmergencyStop(): void;
  disarmEmergencyStop(): void;
  searchKnowledge(q: string): Promise<unknown>;
  getMacros(): Promise<unknown>;
  getSessions(): Promise<unknown>;
  getPrivacyStats(): Promise<unknown>;
  getActivitySummary(): Promise<unknown>;
  getSwarmStatus(): Promise<unknown>;
  getAuditStats(): Promise<unknown>;
  getRepos(): Promise<unknown>;
  getMcpCatalog(opts?: { q?: string; category?: string; enabled?: boolean; limit?: number; offset?: number }): Promise<unknown>;
  connectMcp(id: string, opts: { baseUrl?: string; apiKey?: string; enabled?: boolean }): Promise<unknown>;
  disconnectMcp(id: string): Promise<unknown>;
  /** Start an OAuth connect flow for an `oauth` connector; returns { authorizeUrl, state }. */
  beginMcpOauth(id: string, redirectUri?: string): Promise<unknown>;
  /** OAuth callback completion — code + state (connector id recovered from state). */
  completeMcpOauth(code: string, state: string): Promise<unknown>;
  /** OAuth token status (masked — tokens never returned). */
  getMcpOauthStatus(id: string): Record<string, unknown>;
  /** Refresh an expiring OAuth token. */
  refreshMcpOauth(id: string): Promise<unknown>;
  syncExternalConnectors(opts?: { maxPerSource?: number }): Promise<unknown>;
  syncExternalSources(opts?: { maxPerSource?: number }): Promise<unknown>;
  // ── Connector Marketplace ────────────────────────────────────────
  /** List all connectors with search, category filter, and pagination. */
  listConnectors(opts?: { q?: string; category?: string; limit?: number; offset?: number }): Promise<unknown>;
  /** Get a single connector by ID. */
  getConnector(id: string): Promise<unknown>;
  /** Get all connector categories with counts. */
  getConnectorCategories(): Promise<unknown>;
  /** Start OAuth flow or save API key for a connector. */
  connectConnector(id: string, opts: { apiKey?: string; redirectUri?: string }): Promise<unknown>;
  /** Complete a connector OAuth callback (code + state). */
  completeConnectorOauth(id: string, code: string, state: string, userId?: string): Promise<unknown>;
  /** Honest per-connector readiness (what the user must do to connect it). */
  getConnectorReadiness(id: string, userId?: string): unknown;
  getConnectorReadinessSummary(userId?: string): unknown;
  /** Get connection status for a connector. */
  getConnectorStatus(id: string, userId?: string): Promise<unknown>;
  /** Disconnect a user from a connector. */
  disconnectConnectorApi(id: string, userId?: string): Promise<unknown>;
  /** Execute a connector action. */
  executeConnectorAction(connectorId: string, endpoint: string, method: string, payload: Record<string, unknown>, userId?: string): Promise<unknown>;
  /** Get tools relevant to a user query (for LLM function calling). */
  getRelevantTools(query: string, limit?: number): Promise<unknown>;
  /** List stored tool definitions with per-connector connection state (schema browser). */
  listToolSchemas(opts?: { q?: string; connectorId?: string; limit?: number; offset?: number }): Promise<unknown>;
  /** All stored tool schemas for one connector. */
  getConnectorTools(connectorId: string): Promise<unknown>;
  /** Ingest an OpenAPI spec for one connector on demand (inline or fetched). */
  ingestConnectorOpenApi(opts: {
    connectorId: string;
    spec?: unknown;
    specUrl?: string;
    baseUrl?: string;
    authType?: string;
    apiKeyHeader?: string;
    replace?: boolean;
    maxTools?: number;
  }): Promise<unknown>;
  /** Sync connector catalog from external sources. */
  syncConnectorCatalog(): Promise<unknown>;
  /**
   * Ensure a connector has callable tool schemas, ingesting its OpenAPI spec
   * on demand when it has none. Idempotent — already-indexed connectors
   * short-circuit without re-ingesting.
   */
  ensureConnectorTools(connectorId: string, opts?: { force?: boolean }): Promise<unknown>;
  /** Save developer credentials for a connector. */
  saveConnectorCredential(slug: string, clientId: string, clientSecret: string, scopes: string[]): Promise<unknown>;
  getModelStatus(): Promise<unknown>;
  getPlanUsage(tenantId?: string): Promise<unknown>;
  testLlm(): Promise<unknown>;
  configureProvider(patch: { provider?: string; endpoint?: string; apiKey?: string; models?: Record<string, string>; tier?: string }): Promise<unknown>;
  /** Activate a plan after payment (assigns the plan's token budget). */
  activatePlan(tier: string, tenantId?: string): Promise<unknown>;
  /** Billing (Stripe) — create a checkout session for a plan tier; returns { url }. */
  billingCreateCheckout(tier: string, tenantId?: string): Promise<unknown>;
  /** Multi-tenant: list every registered tenant + its budget/usage/device limit. */
  tenantsList(): Promise<unknown>;
  /** Multi-tenant: register (or update) a tenant; returns its status. */
  tenantsRegister(opts: { id: string; name?: string; tier?: string }): Promise<unknown>;
  /** Multi-tenant: activate a plan for one tenant. */
  tenantsActivate(id: string, tier: string): Promise<unknown>;
  /** Multi-tenant: disable a tenant (falls back to the node default budget). */
  tenantsDisable(id: string): Promise<unknown>;
  /** Billing (Stripe) — verify + handle a webhook (raw body + signature header). */
  billingHandleWebhook(rawBody: string, signature: string): Promise<unknown>;
  getProviderConfig(): Promise<unknown>;
  listOpenMontageTools(): Promise<unknown>;
  generateImage(prompt: string, opts?: { width?: number; height?: number; steps?: number }): Promise<unknown>;
  getVoiceStatus(): Promise<unknown>;
  /** Voice-stack health (STT/TTS/ASR/cable/loopback); refresh re-runs the probes. */
  getVoiceStackHealth(refresh?: boolean): Promise<unknown>;
  transcribeAudio(audioBase64: string, opts?: { format?: string; language?: string }): Promise<unknown>;
  /** Voice command → task: transcribe the audio and submit it as a task. */
  voiceCommand(audioBase64: string, opts?: { format?: string; language?: string; target?: string }): Promise<unknown>;
  speakText(text: string, opts?: { voice?: string; language?: string; provider?: string; engine?: string }): Promise<unknown>;
  listTtsVoices(): Promise<unknown>;
  recallMemory(query: string): Promise<unknown>;
  rememberMemory(text: string): Promise<unknown>;
  screenAsk(question: string, intent?: string): Promise<unknown>;
  screenState(): Promise<unknown>;
  screenLive(): Promise<unknown>;
  screenWatch(enabled: boolean): Promise<unknown>;
  meetingJoin(url: string, opts?: { title?: string; topics?: string[] }): Promise<unknown>;
  meetingStartListening(): Promise<unknown>;
  meetingStatus(): Promise<unknown>;
  meetingLeave(): Promise<unknown>;
  meetingExecute(action: string, params: Record<string, unknown>): Promise<unknown>;
  meetingFeedAudio(audioBase64: string, format?: string): Promise<unknown>;
  meetingShare(target?: string): Promise<unknown>;
  meetingStopShare(): Promise<unknown>;
  meetingOrders(): Promise<unknown>;
  meetingSpeak(text: string, opts?: { voice?: string; language?: string }): Promise<unknown>;
  meetingMute(muted: boolean): Promise<unknown>;
  meetingRaiseHand(raised: boolean): Promise<unknown>;
  meetingChat(message: string): Promise<unknown>;
  listAudioDevices(): Promise<unknown>;
  setAudioDefault(opts: { flow?: 'render' | 'capture'; deviceId?: string }): Promise<unknown>;
  getMeetings(): Promise<unknown>;
  getMeeting(id: string): Promise<unknown>;
  startLoopback(seconds?: number): Promise<unknown>;
  stopLoopback(id: string): Promise<unknown>;
  listRecordings(): Promise<unknown>;
  listDevices(): Promise<unknown>;
  createDeviceInvite(name: string): Promise<unknown>;
  joinDevice(code: string, meta: { name: string; role?: string; capabilities?: string[] }): Promise<unknown>;
  revokeDevice(deviceId: string): Promise<unknown>;
  sendToDevice(deviceId: string, msg: Record<string, unknown>): Promise<unknown>;
  delegateHermes(description: string, opts?: { provider?: string; model?: string; timeoutMs?: number }): Promise<unknown>;
  generateJournalNow(): Promise<unknown>;
  /** Compile recorder-flagged hot skills to native artifacts. */
  compileHotSkills(threshold?: number): Promise<unknown>;
  /** Telco (Telnyx) — send an SMS. */
  telcoSendSms(opts: { to: string; text: string; from?: string }): Promise<unknown>;
  /** Telco (Telnyx) — initiate a voice call. */
  telcoCall(opts: { to: string; from?: string; connectionUrl?: string }): Promise<unknown>;
  /** Telco (Telnyx) — persist the API token + sender number + messaging profile. */
  configureTelco(patch: { apiKey?: string; fromNumber?: string; messagingProfileId?: string; enabled?: boolean }): Promise<unknown>;
  /** Telco (Telnyx) — current settings (token masked out). */
  getTelcoStatus(): Promise<unknown>;
  /** Meeting Bot (Docker SaaS) — join a meeting via the bot service. */
  meetingBotJoin(meetingUrl: string, platform: string, botName?: string): Promise<unknown>;
  /** Meeting Bot — leave the current meeting. */
  meetingBotLeave(): Promise<unknown>;
  /** Meeting Bot — current status. */
  meetingBotStatus(): Promise<unknown>;
  /** Meeting Bot — full transcript. */
  meetingBotTranscript(): Promise<unknown>;
  /** Meeting Bot — send a command. */
  meetingBotCommand(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Docker — run a containerized skill worker. */
  dockerRun(spec: { name: string; image: string; command?: string[]; env?: Record<string, string>; memoryLimitMb?: number; cpuQuotaPct?: number }): Promise<unknown>;
  /** Docker — stop a worker container. */
  dockerStop(name: string): Promise<unknown>;
  /** Docker — remove a worker container. */
  dockerRemove(name: string): Promise<unknown>;
  /** Docker — list tracked worker containers. */
  dockerList(): Promise<unknown>;
  /** Auth (web app) — create a new user account. */
  authSignup(email: string, password: string, name: string): Promise<unknown>;
  /** Auth (web app) — login with email + password. */
  authLogin(email: string, password: string): Promise<unknown>;
  /** Auth (web app) — login with API key (stateless). */
  authLoginWithKey(apiKey: string): Promise<unknown>;
  /** Auth (web app) — list paired devices for a user. */
  authListDevices(apiKey: string): Promise<unknown>;
  /** Auth (web app) — pair a new device (phone/desktop). */
  authPairDevice(apiKey: string, name: string, type: string): Promise<unknown>;
  /** Auth (web app) — remove a paired device. */
  authRemoveDevice(apiKey: string, deviceId: string): Promise<unknown>;
  /** Auth (web app) — get current plan info. */
  authGetPlan(apiKey: string): Promise<unknown>;
  /** Durable task-queue export (filename → JSON text) for desktop↔cloud handoff. */
  exportTaskQueue(): { files: Record<string, string> };
  /** Import task-queue files from another node, then resume unfinished work. */
  importTaskQueue(payload: { files?: Record<string, string> }): Promise<{ imported: number; resumed: number }>;
  /** Rust mesh daemon status (P2P transport). */
  getMeshStatus(): Promise<unknown>;
  meshPair(ttl?: number): Promise<unknown>;
  meshPairDemo(): Promise<unknown>;
  meshRevoke(deviceId: string): Promise<unknown>;
  /** MCP JSON-RPC entrypoint — returns null for notifications (HTTP 202). */
  mcpHandle(message: Record<string, unknown>): Promise<McpJsonRpcResponse | null>;
  /** Chrome Extension — receive batched browser telemetry. */
  handleChromeTelemetry(events: unknown[], sessionId: string, cookieSnapshot: unknown): Promise<unknown>;
  /** Chrome Extension — current connection/session status. */
  getChromeExtensionStatus(): unknown;
  /** Chrome Extension — list detected login/OAuth events. */
  getChromeLoginEvents(): unknown;
  /** Chrome Extension — approve a detected login to save to vault. */
  approveChromeLogin(url: string, provider: string, username?: string): Promise<unknown>;
  /** Chrome Extension — saved cookies (persisted). */
  getChromeCookies(domain?: string): Promise<unknown>;
  /** Chrome Extension — saved sites/history. */
  getChromeSites(): Promise<unknown>;
  /** Connected connectors (from Chrome extension logins). */
  getConnectedConnectors(): Array<{ id: string; name: string; provider: string; connectedAt: number; lastUsed?: number }>;
  /** Disconnect a connector. */
  disconnectConnector(connectorId: string): Promise<boolean>;
  /** JIT Stripe webhook (raw body + signature) */
  handleStripeWebhook(rawBody: string, signature: string): Promise<unknown>;
  /** JIT Smart routing */
  getSmartRoute(userId: string, taskType: string, preferAlt?: boolean): Promise<unknown>;
  deductWallet(userId: string, model: string, usage: Record<string, unknown>): Promise<unknown>;
  getWallet(userId: string): Promise<unknown>;
  /** Social — post immediately to a platform. */
  socialPost(opts: { platform: string; action: string; email: string; password: string; text?: string; comment_text?: string; query?: string; media_files?: string[]; video_path?: string; title?: string; description?: string; max_comments?: number; max_results?: number; headless?: boolean }): Promise<unknown>;
  /** Social — schedule a post for later. */
  socialSchedule(opts: { platform: string; action: string; email: string; password: string; text?: string; video_path?: string; title?: string; description?: string; scheduledAt: number }): Promise<unknown>;
  /** Social — list scheduled posts. */
  socialScheduled(): Promise<unknown>;
  /** Social — cancel a scheduled post by id. */
  socialCancelSchedule(id: string): Promise<unknown>;
  /** Social — get automation status. */
  socialStatus(): Promise<unknown>;
  /** Smart Home — platform catalog (connect cards for the UI). */
  smartPlatforms(): Promise<unknown>;
  /** Smart Home — connect a platform by key with a token (+ optional url). */
  smartConnectPlatform(key: string, token: string, url?: string): Promise<unknown>;
  /** Smart Home — disconnect a platform by key. */
  smartDisconnectPlatform(key: string): Promise<unknown>;
  /** Smart Home — begin an OAuth sign-in for a cloud platform. */
  smartOauthStart(key: string, redirectUri?: string): Promise<unknown>;
  /** Smart Home — finish an OAuth sign-in with the callback code + state. */
  smartOauthCallback(key: string, code: string, state: string): Promise<unknown>;
  /** Smart Home — list devices across all connected platforms (with live switch state). */
  smartDevices(): Promise<unknown>;
  /** Smart Home — send a switch command to a device. */
  smartCommand(deviceId: string, command: 'on' | 'off'): Promise<unknown>;
  /** Smart Home — control a device by (fuzzy) name. */
  smartControlByName(name: string, command: 'on' | 'off'): Promise<unknown>;
  /** Smart Home — list device schedules. */
  smartSchedules(): Promise<unknown>;
  /** Smart Home — add a device schedule. */
  smartScheduleAdd(rule: { deviceId: string; deviceName: string; command: 'on' | 'off'; kind: 'everyMinutes' | 'at'; everyMinutes?: number; at?: string }): Promise<unknown>;
  /** Smart Home — cancel a device schedule. */
  smartScheduleCancel(id: string): Promise<unknown>;
  /** Smart Home — connection status (token masked). */
  smartStatus(): Promise<unknown>;
  /** Smart Home — save PAT (validate before persist). */
  smartSetToken(token: string): Promise<unknown>;
  /** Smart Home — disconnect (clear PAT). */
  smartClearToken(): Promise<unknown>;
  /** Vault — credential store (AES-256-GCM, HWID+DPAPI). */
  getVaultEntries(): Promise<unknown>;
  setVaultEntry(entry: { service: string; username?: string; secret: string; id?: string }): Promise<unknown>;
  deleteVaultEntry(id: string): Promise<unknown>;
  /** Carrusel — start/stop the Open Carrusel server. */
  carruselStart(): Promise<unknown>;
  /** Carrusel — stop the Open Carrusel server. */
  carruselStop(): Promise<unknown>;
  /** Carrusel — get server status. */
  carruselStatus(): Promise<unknown>;
  /** Carrusel — create a carousel. */
  carruselCreate(opts: { name: string; aspectRatio?: string }): Promise<unknown>;
  /** Carrusel — list all carousels. */
  carruselList(): Promise<unknown>;
  /** Carrusel — get a carousel by id. */
  carruselGet(id: string): Promise<unknown>;
  /** Carrusel — add a slide (HTML). */
  carruselAddSlide(opts: { carouselId: string; html: string; note?: string }): Promise<unknown>;
  /** Carrusel — design carousel via Claude chat. */
  carruselChat(opts: { message: string; carouselId?: string }): Promise<unknown>;
  /** Carrusel — export carousel as PNG ZIP. */
  carruselExport(id: string): Promise<{ zipBase64: string; carouselId: string }>;
  /** Carrusel — delete a carousel. */
  carruselDelete(id: string): Promise<unknown>;
  /** Carrusel — get/update brand config. */
  carruselBrand(): Promise<unknown>;
  /** Carrusel — duplicate a carousel. */
  carruselDuplicate(id: string): Promise<unknown>;
  /** Twenty CRM — start the docker compose stack. */
  twentyStart(): Promise<unknown>;
  /** Twenty CRM — stop the docker compose stack. */
  twentyStop(): Promise<unknown>;
  /** Twenty CRM — get stack status. */
  twentyStatus(): Promise<unknown>;
  /** Twenty CRM — run a GraphQL query. */
  twentyGraphql(opts: { query: string; variables?: Record<string, unknown> }): Promise<unknown>;
  shutdown(): void;
}

type Handler = (url: URL, body: Record<string, unknown>, match?: RegExpMatchArray, req?: http.IncomingMessage) => Promise<unknown>;

// 5MB body cap — enforced in readBody()/readRawBody() via MAX_BODY_BYTES.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Absolute stop for the overflow drain in collectBody(). A client that keeps
 * pushing past this gets the socket destroyed — at that point a 413 is not
 * worth holding the event loop for.
 */
const HARD_BODY_CEILING = 4 * MAX_BODY_BYTES;

/** Loopback-only default bind address. See ApiServer.resolveHost(). */
const DEFAULT_BIND_HOST = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True for the loopback aliases only — anything else is LAN-exposed. */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Client-disconnect / write-race socket errors. These mean the reader went
 * away (or we raced a double-send) — never a backend fault, and never worth
 * an unhandled 'error' event that takes the whole process down.
 */
const NON_FATAL_SOCKET_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_CLOSED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

export class ApiServer {
  private server: http.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private deps: ApiServerDeps;
  private port: number;
  private host: string;
  private clients: Set<WebSocket> = new Set();

  constructor(deps: ApiServerDeps, port: number = 8787, host?: string) {
    this.deps = deps;
    this.port = port;
    this.host = ApiServer.resolveHost(host);
  }

  /**
   * Resolve the bind address. Default is loopback ONLY; a wildcard bind is an
   * explicit operator decision and must never happen by accident.
   *
   * Precedence: constructor arg → UMBRA_BIND_HOST → UMBRA_HOST → 127.0.0.1.
   * Blank/whitespace values are skipped (an empty env var previously won the
   * `||` chain and made Node listen on every interface, i.e. 0.0.0.0).
   */
  private static resolveHost(explicit?: string): string {
    for (const candidate of [explicit, process.env['UMBRA_BIND_HOST'], process.env['UMBRA_HOST']]) {
      const host = typeof candidate === 'string' ? candidate.trim() : '';
      if (host) return host;
    }
    return DEFAULT_BIND_HOST;
  }

  start(): void {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      // First thing on the request path — before any body read or write.
      this.guardConnection(req, res);
      this.handleRequest(req, res).catch(err => {
        this.sendError(res, err, 'request');
      });
    });

    // Guard every accepted socket at connection time (before any request
    // handler can write). A client that vanishes mid-response makes the
    // kernel raise EPIPE/ECONNRESET on the raw socket; with no 'error'
    // listener that is an unhandled 'error' event and kills the process.
    this.server.on('connection', socket => {
      // Tests and high-churn clients open/close many sockets; the default
      // 10-listener cap raises MaxListenersExceededWarning. Zero disables the cap.
      socket.setMaxListeners(0);
      socket.on('error', err => ApiServer.onSocketError(err));
    });
    // Malformed request / pre-handler socket failure — destroy quietly instead
    // of letting the default action throw.
    this.server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
      ApiServer.onSocketError(err);
      try { socket.destroy(); } catch { /* already gone */ }
    });

    this.wss = new WebSocket.Server({ server: this.server, path: '/api/ws' });
    this.wss.on('connection', ws => this.handleWsConnection(ws));

    this.server.listen(this.port, this.host);
    this.subscribeBus();
    if (!isLoopbackHost(this.host)) {
      getLogger().warn(
        { host: this.host, port: this.port },
        'API server bound to a NON-loopback address — the control plane is reachable from the network',
      );
    }
    getLogger().info({ port: this.port, host: this.host }, 'API server listening');
  }

  async stop(): Promise<void> {
    this.unsubscribeBus();

    if (this.wss) {
      for (const client of this.clients) {
        try { client.close(); } catch { }
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      if (typeof (this.server as any).closeAllConnections === 'function') {
        (this.server as any).closeAllConnections();
      }
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve());
        setTimeout(resolve, 2000);
      });
      this.server = null;
    }
  }

  // ── Socket safety ─────────────────────────────────────────
  //  A client that closes/times out mid-response (Electron reload, killed
  //  fetch, LAN drop) makes Node emit 'error' on the raw Socket. Without a
  //  listener that surfaces as an unhandled 'error' event and crashes the
  //  backend (see backend-err.log: "Error: write EPIPE ... Unhandled
  //  'error' event"). Every response therefore gets its listeners attached
  //  BEFORE the first write, and res.end() is always try/caught.

  /** Non-fatal → silent no-op; anything else → warn (never throw). */
  private static onSocketError(err: any): void {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code && NON_FATAL_SOCKET_CODES.has(String(code))) return;
    getLogger().warn({ code, err: err?.message }, 'Client socket error');
  }

  /** Attach non-fatal error handling to this request's raw socket + response. */
  private guardConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
    const onError = (err: any) => ApiServer.onSocketError(err);
    try {
      // The raw socket write path — the actual EPIPE emitter. `on` (not
      // `once`) so a second error on the same socket is still handled.
      const socket = req.socket;
      if (socket && socket.listenerCount('error') === 0) socket.on('error', onError);
      if (res.socket && res.socket !== socket && res.socket.listenerCount('error') === 0) {
        res.socket.on('error', onError);
      }
    } catch { /* socket already gone */ }
    try { res.on('error', onError); } catch { /* ignore */ }
    try { req.on('error', onError); } catch { /* ignore */ }
  }

  /** res.end() is the raw socket write: guard it and treat a dead peer as a no-op. */
  private endResponse(res: http.ServerResponse, text?: string, req?: http.IncomingMessage): void {
    try {
      if (res.destroyed || res.writableEnded) return;
      if (req?.socket?.destroyed) return;
      const resSocket = (res as unknown as { socket?: { destroyed?: boolean } }).socket;
      if (resSocket?.destroyed) return;
      if (text === undefined) res.end();
      else res.end(text);
    } catch (err) {
      ApiServer.onSocketError(err);
      try { res.destroy(); } catch { /* already destroyed */ }
    }
  }

  // ── HTTP ──────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.guardConnection(req, res);
    this.setCors(res, req);
    if (req.socket.destroyed) return;
    if (req.method === 'OPTIONS') {
      try {
        res.writeHead(204);
      } catch (err) {
        ApiServer.onSocketError(err);
        return;
      }
      this.endResponse(res, undefined, req);
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const route = `${req.method} ${url.pathname}`;

    // Stripe webhooks must be verified over the RAW body (HMAC over the exact
    // bytes), so handle this route before JSON parsing. Stripe retries non-2xx.
    if (route === 'POST /api/billing/webhook') {
      const rawBody = await this.readRawBody(req);
      try {
        const result = await this.deps.billingHandleWebhook(rawBody, String(req.headers['stripe-signature'] || ''));
        this.sendJson(res, 200, result, req);
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'Billing webhook failed');
        this.sendJson(res, 400, { error: err.message || 'Webhook failed' }, req);
      }
      return;
    }
    // JIT spec endpoint: /api/stripe-webhook (uses stripe.webhooks.constructEvent)
    if (route === 'POST /api/stripe-webhook') {
      const rawBody = await this.readRawBody(req);
      const sig = String(req.headers['stripe-signature'] || req.headers['Stripe-Signature'] || '');
      try {
        // Prefer JIT handler if available, else fallback to billing
        const handler: any = (this.deps as any).handleStripeWebhook || this.deps.billingHandleWebhook;
        const result = await handler(rawBody, sig);
        this.sendJson(res, 200, result, req);
      } catch (err: any) {
        getLogger().warn({ err: err.message }, 'Stripe JIT webhook failed');
        this.sendJson(res, 400, { error: err.message || 'Webhook failed' }, req);
      }
      return;
    }

    let body: Record<string, unknown> = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      body = await this.readBody(req);
    }

    // MCP (Model Context Protocol) endpoint — JSON-RPC over HTTP for the
    // built-in reasoning engine to call Umbra's connectors.
    if (route === 'POST /mcp') {
      await this.handleMcp(body, res, req);
      return;
    }

    const handler = this.routeHandler(route, req);
    if (!handler) {
      this.sendJson(res, 404, { error: `No route: ${route}` }, req);
      return;
    }

    // Multi-tenant: bind the caller's X-Umbra-Tenant header to the whole
    // async chain, so every LLM call this request spawns meters against that
    // tenant's own $5/$10 budget (TenantLedger.current()).
    // NOTE: route uses url.pathname only (never logs query → ?key= never hits logs).
    const tenantId = String(req.headers['x-umbra-tenant'] || '').trim() || undefined;
    try {
      const result = await TenantLedger.run(tenantId, () => handler(url, body, undefined, req));
      this.sendJson(res, 200, result, req);
    } catch (err: any) {
      this.sendError(res, err, route, req);
    }
  }

  /**
   * Map a thrown error to a structured HTTP error response.
   *
   * Precedence:
   *   1. `AppError` (and the `validate.ts` helpers, which throw it) carries its
   *      own status — 400/404/413/422/501/503 — and is honoured verbatim. This
   *      used to be dropped on the floor, which turned every zod validation
   *      failure into a 500 "Internal error".
   *   2. An optional dependency missing on this node (cancelTask, workerClaim,
   *      …) is 501 Not Implemented, not an internal fault.
   *   3. A feature that is configured-but-off (voice, telco, docker, social)
   *      is 503 Service Unavailable, so clients can retry later.
   *   4. Everything else stays 500.
   */
  private sendError(res: http.ServerResponse, err: any, route: string, req?: http.IncomingMessage): void {
    const msg = err?.message || 'Internal error';

    let status: number;
    let code: string;
    if (isAppError(err)) {
      status = err.status;
      code = codeForStatus(err.status);
    } else if (/not available on this node/i.test(msg)) {
      status = 501;
      code = 'NOT_IMPLEMENTED';
    } else if (/not configured|disabled|unavailable|not enabled|unreachable/i.test(msg)) {
      status = 503;
      code = 'SERVICE_DISABLED';
    } else {
      status = 500;
      code = 'INTERNAL_ERROR';
    }

    if (status === 413) {
      // The request body was refused mid-stream; the unread remainder must not
      // be interpreted as the next pipelined request.
      try { res.setHeader('Connection', 'close'); } catch { /* client gone */ }
    }
    // 4xx/5xx that are the caller's fault are not worth a stack-trace log line.
    if (status >= 500) {
      getLogger().warn({ route, err: msg, status, code }, 'API route failed');
    } else {
      getLogger().debug({ route, err: msg, status, code }, 'API request rejected');
    }
    this.sendJson(res, status, { error: msg, code }, req);
  }

  private async handleMcp(body: Record<string, unknown>, res: http.ServerResponse, req?: http.IncomingMessage): Promise<void> {
    try {
      const response = await this.deps.mcpHandle(body);
      if (response === null) {
        try {
          res.writeHead(202);
        } catch { /* client gone */ }
        this.endResponse(res, undefined, req);
        return;
      }
      this.sendJson(res, 200, response, req);
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'MCP endpoint failed');
      this.sendJson(res, 500, {
        jsonrpc: '2.0',
        id: body && typeof body === 'object' ? body['id'] ?? null : null,
        error: { code: -32603, message: err?.message || 'Internal error' },
      }, req);
    }
  }

  private routeHandler(route: string, req?: http.IncomingMessage): Handler | null {
    // Skeleton refactor: sub-routers own their domains; ApiServer composes them.
    // Order preserves original precedence for overlapping patterns.
    const composed: Array<[RegExp, Handler]> = [
      ...agentRoutes(this.deps),
      ...browserRoutes(this.deps),
      ...actionRoutes(this.deps),
      ...computerRoutes(this.deps),
    ];
    for (const [pattern, handler] of composed) {
      const match = route.match(pattern);
      if (match) {
        return (url, body, _m, reqOverride) => handler(url, body, match, reqOverride ?? req);
      }
    }
    // Fallback to legacy map during migration (covers any route not yet extracted).
    return this.legacyRouteHandler(route, req);
  }

  private legacyRouteHandler(route: string, req?: http.IncomingMessage): Handler | null {
    const map: Array<[RegExp, Handler]> = [
      [/^GET \/api\/health$/, async () => ({ ok: true, uptimeMs: process.uptime() * 1000 })],
      [/^GET \/api\/status$/, async () => this.deps.getStatus()],
      [/^GET \/api\/tasks$/, async () => ({ tasks: this.deps.getActiveTasks() })],
      [/^GET \/api\/task\/([\w-]+)$/, async (_url, _body, match) => {
        const task = this.deps.getTask(match![1]);
        if (!task) throw new Error('Task not found');
        return { task };
      }],
      [/^POST \/api\/task$/, async (_url, body) => {
        const description = String(body.description || '').trim();
        if (!description) throw new Error('description is required');
        const priority = Number(body.priority || 0);
        const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey) : undefined;
        const taskId = await this.deps.submitTask(description, priority, idempotencyKey);
        return { taskId };
      }],
      [/^POST \/api\/task\/([\w-]+)\/cancel$/, async (_url, _body, match) => {
        if (!this.deps.cancelTask) throw new AppError('cancelTask is not available on this node', 501);
        const taskId = match![1];
        await this.deps.cancelTask(taskId);
        return { cancelled: taskId };
      }],
      [/^POST \/api\/task\/([\w-]+)\/retry$/, async (_url, body, match) => {
        if (!this.deps.retryTask) throw new AppError('retryTask is not available on this node', 501);
        const taskId = match![1];
        const description = body.description !== undefined ? String(body.description) : undefined;
        const retried = await this.deps.retryTask(taskId, description);
        return { taskId: retried && typeof retried === 'object' && 'id' in retried ? String((retried as { id: string }).id) : taskId };
      }],
      [/^POST \/api\/chat$/, async (_url, body) => {
        const message = String(body.message || body.text || '').trim();
        if (!message) throw new Error('message is required');
        const target = body.target !== undefined ? String(body.target) : 'auto';
        return { dispatch: await this.deps.chat(message, target) };
      }],
      [/^POST \/api\/desktop2\/action$/, async (_url, body) => {
        const action = String(body.action || '');
        if (!action) throw new Error('action is required');
        const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};
        return { result: await this.deps.executeDesktop2(action, params) };
      }],
      [/^POST \/api\/ghost\/action$/, async (_url, body) => {
        const action = String(body.action || '');
        if (!action) throw new Error('action is required');
        const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};
        return { result: await this.deps.executeGhost(action, params) };
      }],
      [/^GET \/api\/ghost\/capture$/, async () => {
        const png = await this.deps.captureGhost();
        if (!png) throw new AppError('No capture available — open Chrome or an app on Desktop 2 first', 404);
        return { image: png };
      }],
      [/^GET \/api\/consent$/, async () => ({
        ...this.deps.getConsentState(),
        emergencyStopArmed: this.deps.isEmergencyStopArmed(),
      })],
      [/^POST \/api\/consent$/, async (_url, body) => {
        const action = String(body.action || '');
        if (action === 'request') {
          const reason = String(body.reason || 'Request from UI');
          return { result: await this.deps.requestConsent(reason) };
        }
        if (action === 'arm') {
          this.deps.armEmergencyStop();
          return { result: 'armed' };
        }
        if (action === 'disarm') {
          if (body.confirm !== true) throw new Error('Emergency stop disarm requires explicit confirmation (body.confirm === true)');
          this.deps.disarmEmergencyStop();
          return { result: 'disarmed' };
        }
        throw new Error(`Unknown consent action: ${action}`);
      }],
      [/^GET \/api\/knowledge\/search$/, async url => ({ results: await this.deps.searchKnowledge(url.searchParams.get('q') || '') })],
      [/^GET \/api\/memory\/recall$/, async url => this.deps.recallMemory(url.searchParams.get('q') || '')],
      [/^POST \/api\/memory\/remember$/, async (_url, body) => {
        const text = String(body.text || '').trim();
        if (!text) throw new Error('text is required');
        return this.deps.rememberMemory(text);
      }],
      [/^GET \/api\/screen\/state$/, async () => this.deps.screenState()],
      [/^GET \/api\/screen\/live$/, async () => this.deps.screenLive()],
      [/^POST \/api\/screen\/watch$/, async (_url, body) => this.deps.screenWatch(body.enabled !== false)],
      [/^POST \/api\/screen\/ask$/, async (_url, body) => {
        const question = String(body.question || '').trim();
        if (!question) throw new Error('question is required');
        const intent = body.intent !== undefined ? String(body.intent) : 'answer';
        return this.deps.screenAsk(question, intent);
      }],
      [/^POST \/api\/meeting\/join$/, async (_url, body) => {
        const url = String(body.url || '').trim();
        if (!url) throw new Error('url is required');
        const opts = {
          title: body.title !== undefined ? String(body.title) : undefined,
          topics: Array.isArray(body.topics) ? body.topics.map(String) : undefined,
        };
        return { meeting: await this.deps.meetingJoin(url, opts) };
      }],
      [/^POST \/api\/meeting\/listen$/, async () => this.deps.meetingStartListening()],
      [/^GET \/api\/meeting\/status$/, async () => this.deps.meetingStatus()],
      [/^POST \/api\/meeting\/leave$/, async () => ({ meeting: await this.deps.meetingLeave() })],
      [/^POST \/api\/meeting\/execute$/, async (_url, body) => {
        const action = String(body.action || '');
        if (!action) throw new Error('action is required');
        const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};
        return this.deps.meetingExecute(action, params);
      }],
      [/^POST \/api\/meeting\/audio$/, async (_url, body) => {
        const audio = String(body.audio || '');
        if (!audio) throw new Error('audio (base64) is required');
        return {
          segment: await this.deps.meetingFeedAudio(audio, body.format !== undefined ? String(body.format) : undefined),
        };
      }],
      [/^POST \/api\/meeting\/share$/, async (_url, body) => ({
        result: await this.deps.meetingShare(body.target !== undefined ? String(body.target) : undefined),
      })],
      [/^POST \/api\/meeting\/stop-share$/, async () => ({ result: await this.deps.meetingStopShare() })],
      [/^GET \/api\/meeting\/orders$/, async () => this.deps.meetingOrders()],
      [/^POST \/api\/meeting\/speak$/, async (_url, body) => {
        const text = String(body.text || '').trim();
        if (!text) throw new Error('text is required');
        return { result: await this.deps.meetingSpeak(text, {
          voice: body.voice !== undefined ? String(body.voice) : undefined,
          language: body.language !== undefined ? String(body.language) : undefined,
        }) };
      }],
      [/^POST \/api\/meeting\/mute$/, async (_url, body) => ({
        result: await this.deps.meetingMute(body.muted !== false),
      })],
      [/^POST \/api\/meeting\/raise-hand$/, async (_url, body) => ({
        result: await this.deps.meetingRaiseHand(body.raised !== false),
      })],
      [/^POST \/api\/meeting\/chat$/, async (_url, body) => {
        const message = String(body.message || '').trim();
        if (!message) throw new Error('message is required');
        return { result: await this.deps.meetingChat(message) };
      }],
      // ── Meeting Bot (Docker SaaS) ──
      [/^POST \/api\/meeting-bot\/join$/, async (_url, body) => {
        const meetingUrl = String(body.meeting_url || '');
        if (!meetingUrl) throw new Error('meeting_url is required');
        const platform = String(body.platform || 'google_meet');
        const botName = body.bot_name !== undefined ? String(body.bot_name) : undefined;
        return { bot: await this.deps.meetingBotJoin(meetingUrl, platform, botName) };
      }],
      [/^POST \/api\/meeting-bot\/leave$/, async () => ({ bot: await this.deps.meetingBotLeave() })],
      [/^GET \/api\/meeting-bot\/status$/, async () => ({ bot: await this.deps.meetingBotStatus() })],
      [/^GET \/api\/meeting-bot\/transcript$/, async () => ({ bot: await this.deps.meetingBotTranscript() })],
      [/^POST \/api\/meeting-bot\/command$/, async (_url, body) => {
        const command = String(body.command || '');
        if (!command) throw new Error('command is required');
        const args = body.args !== undefined && typeof body.args === 'object' ? body.args as Record<string, unknown> : undefined;
        return { bot: await this.deps.meetingBotCommand(command, args) };
      }],
      [/^GET \/api\/audio\/devices$/, async () => ({ audio: await this.deps.listAudioDevices() })],
      [/^POST \/api\/audio\/set-default$/, async (_url, body) => {
        const flow = body.flow === 'capture' ? 'capture' as const : 'render' as const;
        const deviceId = String(body.deviceId || '');
        if (!deviceId) throw new Error('deviceId is required');
        return this.deps.setAudioDefault({ flow, deviceId });
      }],
      [/^GET \/api\/meetings$/, async () => ({ meetings: await this.deps.getMeetings() })],
      [/^GET \/api\/meetings\/([\w-]+)$/, async (_url, _body, match) => ({ meeting: await this.deps.getMeeting(match![1]) })],
      [/^POST \/api\/audio\/loopback\/start$/, async (_url, body) => ({ recording: await this.deps.startLoopback(body.seconds !== undefined ? Number(body.seconds) : undefined) })],
      [/^POST \/api\/audio\/loopback\/stop$/, async (_url, body) => {
        const id = String(body.id || '');
        if (!id) throw new Error('id is required');
        return { recording: await this.deps.stopLoopback(id) };
      }],
      [/^GET \/api\/audio\/recordings$/, async () => ({ recordings: await this.deps.listRecordings() })],
      [/^GET \/api\/macros$/, async () => ({ macros: await this.deps.getMacros() })],
      [/^GET \/api\/sessions$/, async () => ({ sessions: await this.deps.getSessions() })],
      [/^GET \/api\/privacy\/stats$/, async () => this.deps.getPrivacyStats()],
      [/^GET \/api\/activity\/summary$/, async () => this.deps.getActivitySummary()],
      [/^GET \/api\/swarm$/, async () => ({ swarm: await this.deps.getSwarmStatus() })],
      [/^GET \/api\/vault\/stats$/, async () => ({ vault: await this.deps.getAuditStats() })],
      [/^GET \/api\/repos$/, async () => ({ repos: await this.deps.getRepos() })],
      [/^GET \/api\/mcp\/catalog$/, async url => ({
        catalog: await this.deps.getMcpCatalog({
          q: url.searchParams.get('q') || undefined,
          category: url.searchParams.get('category') || undefined,
          enabled: url.searchParams.get('enabled') !== null ? url.searchParams.get('enabled') === 'true' : undefined,
          limit: url.searchParams.get('limit') !== null ? Number(url.searchParams.get('limit')) : undefined,
          offset: url.searchParams.get('offset') !== null ? Number(url.searchParams.get('offset')) : undefined,
        }),
      })],
      [/^GET \/api\/mcp\/connectors$/, async () => ({
        connectors: await this.deps.getMcpCatalog({ enabled: true }),
      })],
      [/^POST \/api\/mcp\/disconnect$/, async (_url, body) => {
        const id = String(body.id || '');
        if (!id) throw new Error('id is required');
        return { connector: await this.deps.disconnectMcp(id) };
      }],
      [/^POST \/api\/mcp\/import-registry$/, async (_url, body) => ({
        result: await this.deps.syncExternalSources({
          maxPerSource: body.maxPerSource !== undefined ? Number(body.maxPerSource) : undefined,
        }),
      })],
      // ── Connector Marketplace Routes ───────────────────────────────
      [/^GET \/api\/connectors$/, async url => ({
        connectors: await this.deps.listConnectors({
          q: url.searchParams.get('q') || undefined,
          category: url.searchParams.get('category') || undefined,
          limit: url.searchParams.get('limit') !== null ? Number(url.searchParams.get('limit')) : undefined,
          offset: url.searchParams.get('offset') !== null ? Number(url.searchParams.get('offset')) : undefined,
        }),
      })],
      [/^GET \/api\/connectors\/categories$/, async () => ({
        categories: await this.deps.getConnectorCategories(),
      })],
      [/^GET \/api\/connectors\/search$/, async url => ({
        connectors: await this.deps.listConnectors({
          q: url.searchParams.get('q') || undefined,
          category: url.searchParams.get('category') || undefined,
          limit: 50,
        }),
      })],
      [/^GET \/api\/connectors\/([\w-]+)$/, async (_url, _body, match) => ({
        connector: await this.deps.getConnector(match![1]),
      })],
      [/^POST \/api\/connectors\/([\w-]+)\/connect$/, async (_url, body, match) => {
        const id = match![1];
        return this.deps.connectConnector(id, {
          apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
          redirectUri: body.redirectUri !== undefined ? String(body.redirectUri) : undefined,
        });
      }],
      // The OAuth completion leg of POST /connect — without this route the
      // connect flow redirected to a 404 and could never finish.
      [/^GET \/api\/connectors\/([\w-]+)\/callback$/, async (url, _body, match) => {
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        if (!code || !state) throw new Error('code and state are required');
        return { oauth: await this.deps.completeConnectorOauth(match![1], code, state) };
      }],
      [/^GET \/api\/connectors\/([\w-]+)\/status$/, async (url, _body, match) => ({
        status: await this.deps.getConnectorStatus(match![1], url.searchParams.get('userId') || undefined),
      })],
      [/^GET \/api\/connectors\/readiness$/, async url => ({
        readiness: this.deps.getConnectorReadinessSummary(url.searchParams.get('userId') || undefined),
      })],
      [/^GET \/api\/connectors\/([\w-]+)\/readiness$/, async (url, _body, match) => ({
        readiness: this.deps.getConnectorReadiness(match![1], url.searchParams.get('userId') || undefined),
      })],
      [/^GET \/api\/connectors\/([\w-]+)\/tools$/, async (_url, _body, match) =>
        this.deps.getConnectorTools(match![1])],
      [/^POST \/api\/connectors\/([\w-]+)\/disconnect$/, async (_url, _body, match) => ({
        result: await this.deps.disconnectConnectorApi(match![1]),
      })],
      [/^POST \/api\/connectors\/execute$/, async (_url, body) => {
        const connectorId = String(body.connectorId || '');
        const endpoint = String(body.endpoint || '/');
        const method = String(body.method || 'GET').toUpperCase();
        const payload = (body.payload && typeof body.payload === 'object') ? body.payload as Record<string, unknown> : {};
        const userId = body.userId !== undefined ? String(body.userId) : undefined;
        if (!connectorId) throw new Error('connectorId is required');
        return this.deps.executeConnectorAction(connectorId, endpoint, method, payload, userId);
      }],
      [/^POST \/api\/connectors\/tools$/, async (_url, body) => {
        const query = String(body.query || '');
        if (!query) throw new Error('query is required');
        const limit = body.limit !== undefined ? Number(body.limit) : undefined;
        return { tools: await this.deps.getRelevantTools(query, limit) };
      }],
      [/^GET \/api\/connectors\/tools\/schemas$/, async url =>
        this.deps.listToolSchemas({
          q: url.searchParams.get('q') || undefined,
          connectorId: url.searchParams.get('connectorId') || undefined,
          limit: url.searchParams.get('limit') !== null ? Number(url.searchParams.get('limit')) : undefined,
          offset: url.searchParams.get('offset') !== null ? Number(url.searchParams.get('offset')) : undefined,
        })],
      [/^POST \/api\/connectors\/ingest-openapi$/, async (_url, body) => {
        if (!body.connectorId) throw new Error('connectorId is required');
        if (body.spec === undefined && !body.specUrl) throw new Error('spec or specUrl is required');
        return this.deps.ingestConnectorOpenApi({
        connectorId: String(body.connectorId || ''),
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
        ...(body.specUrl !== undefined ? { specUrl: String(body.specUrl) } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: String(body.baseUrl) } : {}),
        ...(body.authType !== undefined ? { authType: String(body.authType) } : {}),
        ...(body.apiKeyHeader !== undefined ? { apiKeyHeader: String(body.apiKeyHeader) } : {}),
        ...(body.replace !== undefined ? { replace: body.replace === true } : {}),
        ...(body.maxTools !== undefined ? { maxTools: Number(body.maxTools) } : {}),
        });
      }],
      [/^POST \/api\/connectors\/sync$/, async () => ({
        result: await this.deps.syncConnectorCatalog(),
      })],
      [/^POST \/api\/connectors\/credential$/, async (_url, body) => {
        const slug = String(body.slug || '');
        if (!slug) throw new Error('slug is required');
        const clientId = String(body.clientId || body.client_id || '');
        const clientSecret = String(body.clientSecret || body.client_secret || '');
        const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
        return this.deps.saveConnectorCredential(slug, clientId, clientSecret, scopes);
      }],
      [/^GET \/api\/llm\/models$/, async () => this.deps.getModelStatus()],
      [/^GET \/api\/plan\/usage$/, async url => this.deps.getPlanUsage(url.searchParams.get('tenant') || undefined)],
      [/^POST \/api\/llm\/test$/, async () => this.deps.testLlm()],
      [/^GET \/api\/config\/provider$/, async () => this.deps.getProviderConfig()],
      [/^POST \/api\/plan\/activate$/, async (_url, body) => {
        const tier = String(body.tier || '');
        if (!tier) throw new Error('tier is required');
        const tenant = body.tenant !== undefined ? String(body.tenant) : undefined;
        return this.deps.activatePlan(tier, tenant);
      }],
      [/^GET \/api\/billing\/checkout$/, async url => {
        const tier = url.searchParams.get('tier') || '';
        if (!tier) throw new Error('tier is required');
        const tenant = url.searchParams.get('tenant') || undefined;
        return { checkout: await this.deps.billingCreateCheckout(tier, tenant) };
      }],
      [/^GET \/api\/tenants$/, async () => ({ tenants: await this.deps.tenantsList() })],
      [/^POST \/api\/tenants\/register$/, async (_url, body) => {
        const id = String(body.id || '').trim();
        if (!id) throw new Error('tenant id is required');
        return { tenant: await this.deps.tenantsRegister({
          id,
          name: body.name !== undefined ? String(body.name) : undefined,
          tier: body.tier !== undefined ? String(body.tier) : undefined,
        }) };
      }],
      [/^POST \/api\/tenants\/activate$/, async (_url, body) => {
        const id = String(body.id || '').trim();
        const tier = String(body.tier || '');
        if (!id || !tier) throw new Error('tenant id and tier are required');
        return { tenant: await this.deps.tenantsActivate(id, tier) };
      }],
      [/^POST \/api\/tenants\/disable$/, async (_url, body) => {
        const id = String(body.id || '').trim();
        if (!id) throw new Error('tenant id is required');
        return { tenant: await this.deps.tenantsDisable(id) };
      }],
      [/^POST \/api\/config\/provider$/, async (_url, body) => this.deps.configureProvider({
        provider: body.provider !== undefined ? String(body.provider) : undefined,
        endpoint: body.endpoint !== undefined ? String(body.endpoint) : undefined,
        apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
        models: body.models && typeof body.models === 'object' ? body.models as Record<string, string> : undefined,
        tier: body.tier !== undefined ? String(body.tier) : undefined,
      })],
      [/^GET \/api\/openmontage\/tools$/, async () => ({ openmontage: await this.deps.listOpenMontageTools() })],
      [/^POST \/api\/image\/generate$/, async (_url, body) => {
        const prompt = String(body.prompt || '');
        if (!prompt) throw new Error('prompt is required');
        return {
          image: await this.deps.generateImage(prompt, {
            width: body.width !== undefined ? Number(body.width) : undefined,
            height: body.height !== undefined ? Number(body.height) : undefined,
            steps: body.steps !== undefined ? Number(body.steps) : undefined,
          }),
        };
      }],
      [/^GET \/api\/voice\/status$/, async () => this.deps.getVoiceStatus()],
      [/^GET \/api\/voice\/health$/, async url => this.deps.getVoiceStackHealth(url.searchParams.get('refresh') === '1')],
      [/^GET \/api\/voice\/tts\/voices$/, async () => this.deps.listTtsVoices()],
      [/^POST \/api\/voice\/speak$/, async (_url, body) => {
        const text = String(body.text || '').trim();
        if (!text) throw new Error('text is required');
        return this.deps.speakText(text, {
          voice: body.voice !== undefined ? String(body.voice) : undefined,
          language: body.language !== undefined ? String(body.language) : undefined,
          provider: body.provider !== undefined ? String(body.provider) : undefined,
          engine: body.engine !== undefined ? String(body.engine) : undefined,
        });
      }],
      [/^POST \/api\/voice\/transcribe$/, async (_url, body) => {
        const audio = String(body.audio || '');
        if (!audio) throw new Error('audio (base64) is required');
        return {
          transcription: await this.deps.transcribeAudio(audio, {
            format: body.format !== undefined ? String(body.format) : undefined,
            language: body.language !== undefined ? String(body.language) : undefined,
          }),
        };
      }],
      [/^POST \/api\/voice\/command$/, async (_url, body) => {
        const audio = String(body.audio || '');
        if (!audio) throw new Error('audio (base64) is required');
        return {
          command: await this.deps.voiceCommand(audio, {
            format: body.format !== undefined ? String(body.format) : undefined,
            language: body.language !== undefined ? String(body.language) : undefined,
            target: body.target !== undefined ? String(body.target) : undefined,
          }),
        };
      }],
      [/^POST \/api\/mcp\/connect$/, async (_url, body) => {
        const id = String(body.id || '');
        if (!id) throw new Error('id is required');
        const opts = {
          baseUrl: body.baseUrl !== undefined ? String(body.baseUrl) : undefined,
          apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
        };
        return { connector: await this.deps.connectMcp(id, opts) };
      }],
      [/^POST \/api\/mcp\/oauth\/start$/, async (_url, body) => {
        const id = String(body.id || '');
        if (!id) throw new Error('id is required');
        return { oauth: await this.deps.beginMcpOauth(id, body.redirectUri !== undefined ? String(body.redirectUri) : undefined) };
      }],
      [/^GET \/api\/mcp\/oauth\/callback$/, async url => {
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        if (!code || !state) throw new Error('code and state are required');
        return { oauth: await this.deps.completeMcpOauth(code, state) };
      }],
      [/^GET \/api\/mcp\/oauth\/status$/, async url => {
        const id = url.searchParams.get('id') || '';
        if (!id) throw new Error('id is required');
        return { oauth: this.deps.getMcpOauthStatus(id) };
      }],
      [/^POST \/api\/mcp\/oauth\/refresh$/, async (_url, body) => {
        const id = String(body.id || '');
        if (!id) throw new Error('id is required');
        return { oauth: await this.deps.refreshMcpOauth(id) };
      }],
      [/^POST \/api\/mcp\/sync$/, async (_url, body) => {
        const maxPerSource = body.maxPerSource !== undefined ? Number(body.maxPerSource) : 100;
        return { sync: await this.deps.syncExternalConnectors({ maxPerSource }) };
      }],
      [/^POST \/api\/agent\/delegate$/, async (_url, body) => {
        const description = String(body.description || '');
        if (!description) throw new Error('description is required');
        const opts = {
          provider: body.provider !== undefined ? String(body.provider) : undefined,
          model: body.model !== undefined ? String(body.model) : undefined,
          timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : undefined,
        };
        return { output: await this.deps.delegateHermes(description, opts) };
      }],
      [/^POST \/api\/journal\/generate$/, async () => ({ journal: await this.deps.generateJournalNow() })],
      [/^POST \/api\/skills\/compile-hot$/, async (_url, body) => ({
        compiled: await this.deps.compileHotSkills(body.threshold !== undefined ? Number(body.threshold) : undefined),
      })],
      [/^GET \/api\/telco\/status$/, async () => this.deps.getTelcoStatus()],
      [/^POST \/api\/telco\/configure$/, async (_url, body) => ({
        telco: await this.deps.configureTelco({
          apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
          fromNumber: body.fromNumber !== undefined ? String(body.fromNumber) : undefined,
          messagingProfileId: body.messagingProfileId !== undefined ? String(body.messagingProfileId) : undefined,
          enabled: body.enabled !== undefined ? body.enabled === true || body.enabled === 'true' : undefined,
        }),
      })],
      [/^POST \/api\/telco\/sms$/, async (_url, body) => {
        const to = String(body.to || '');
        const text = String(body.text || '');
        if (!to || !text) throw new Error('to and text are required');
        return { result: await this.deps.telcoSendSms({ to, text, from: body.from !== undefined ? String(body.from) : undefined }) };
      }],
      [/^POST \/api\/telco\/call$/, async (_url, body) => {
        const to = String(body.to || '');
        if (!to) throw new Error('to is required');
        return { result: await this.deps.telcoCall({
          to,
          from: body.from !== undefined ? String(body.from) : undefined,
          connectionUrl: body.connectionUrl !== undefined ? String(body.connectionUrl) : undefined,
        }) };
      }],
      [/^POST \/api\/docker\/run$/, async (_url, body) => {
        const name = String(body.name || '');
        const image = String(body.image || '');
        if (!name || !image) throw new Error('name and image are required');
        return { container: await this.deps.dockerRun({
          name,
          image,
          command: Array.isArray(body.command) ? body.command.map(String) : undefined,
          env: body.env && typeof body.env === 'object' ? body.env as Record<string, string> : undefined,
          memoryLimitMb: body.memoryLimitMb !== undefined ? Number(body.memoryLimitMb) : undefined,
          cpuQuotaPct: body.cpuQuotaPct !== undefined ? Number(body.cpuQuotaPct) : undefined,
        }) };
      }],
      [/^POST \/api\/docker\/stop$/, async (_url, body) => {
        const name = String(body.name || '');
        if (!name) throw new Error('name is required');
        return { stopped: await this.deps.dockerStop(name) };
      }],
      [/^POST \/api\/docker\/remove$/, async (_url, body) => {
        const name = String(body.name || '');
        if (!name) throw new Error('name is required');
        return { removed: await this.deps.dockerRemove(name) };
      }],
      [/^GET \/api\/docker\/list$/, async () => ({ containers: await this.deps.dockerList() })],
      [/^GET \/api\/task-queue\/export$/, async () => this.deps.exportTaskQueue()],
      [/^POST \/api\/task-queue\/import$/, async (_url, body) => ({
        sync: await this.deps.importTaskQueue({
          files: body.files && typeof body.files === 'object' ? body.files as Record<string, string> : undefined,
        }),
      })],
      [/^GET \/api\/mesh\/status$/, async () => this.deps.getMeshStatus()],
      [/^POST \/api\/mesh\/pair$/, async (_url, body) => ({
        pair: await this.deps.meshPair(body.ttl !== undefined ? Number(body.ttl) : 120),
      })],
      [/^POST \/api\/mesh\/pair-demo$/, async () => ({ pair: await this.deps.meshPairDemo() })],
      [/^POST \/api\/mesh\/revoke$/, async (_url, body) => {
        const deviceId = String(body.deviceId || '');
        if (!deviceId) throw new Error('deviceId is required');
        return { revoked: await this.deps.meshRevoke(deviceId) };
      }],
      [/^GET \/api\/devices$/, async () => ({ devices: await this.deps.listDevices() })],
      [/^POST \/api\/devices\/invite$/, async (_url, body) => {
        const name = body.name !== undefined ? String(body.name) : '';
        return { invite: await this.deps.createDeviceInvite(name) };
      }],
      [/^POST \/api\/devices\/join$/, async (_url, body) => {
        const code = String(body.code || '');
        if (!code) throw new Error('code is required');
        const meta = {
          name: body.name !== undefined ? String(body.name) : 'Device',
          role: body.role !== undefined ? String(body.role) : undefined,
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
        };
        return { join: await this.deps.joinDevice(code, meta) };
      }],
      [/^POST \/api\/devices\/revoke$/, async (_url, body) => {
        const deviceId = String(body.deviceId || '');
        if (!deviceId) throw new Error('deviceId is required');
        return { revoked: await this.deps.revokeDevice(deviceId) };
      }],
      [/^POST \/api\/devices\/send$/, async (_url, body) => {
        const deviceId = String(body.deviceId || '');
        if (!deviceId) throw new Error('deviceId is required');
        const msg = (body.msg && typeof body.msg === 'object') ? body.msg as Record<string, unknown> : {};
        return { sent: await this.deps.sendToDevice(deviceId, msg) };
      }],
      [/^POST \/api\/chrome\/telemetry$/, async (_url, body) => {
        const events = Array.isArray(body.events) ? body.events : [];
        const sessionId = String(body.sessionId || '');
        const cookieSnapshot = body.cookieSnapshot || {};
        return this.deps.handleChromeTelemetry(events, sessionId, cookieSnapshot);
      }],
      [/^GET \/api\/chrome\/status$/, async () => this.deps.getChromeExtensionStatus()],
      [/^GET \/api\/chrome\/logins$/, async () => this.deps.getChromeLoginEvents()],
      [/^POST \/api\/chrome\/logins\/approve$/, async (_url, body) => {
        const url = String(body.url || '');
        const provider = String(body.provider || '');
        const username = body.username !== undefined ? String(body.username) : undefined;
        if (!url || !provider) throw new Error('url and provider are required');
        return { approved: await this.deps.approveChromeLogin(url, provider, username) };
      }],
      [/^GET \/api\/chrome\/cookies$/, async (url) => {
        const domain = url.searchParams.get('domain') || undefined;
        return { cookies: await this.deps.getChromeCookies(domain) };
      }],
      [/^GET \/api\/chrome\/sites$/, async () => ({ sites: await this.deps.getChromeSites() })],
      // ── Social media automation ─────────────────────────────────
      [/^POST \/api\/social\/post$/, async (_url, body) => {
        const platform = String(body.platform || '');
        if (!platform) throw new Error('platform is required (x, youtube, instagram)');
        const action = String(body.action || 'post');
        const email = String(body.email || '');
        const password = String(body.password || '');
        if (!email || !password) throw new Error('email and password are required');
        return { result: await this.deps.socialPost({
          platform, action, email, password,
          text: body.text !== undefined ? String(body.text) : undefined,
          comment_text: body.comment_text !== undefined ? String(body.comment_text) : undefined,
          query: body.query !== undefined ? String(body.query) : undefined,
          media_files: Array.isArray(body.media_files) ? body.media_files.map(String) : undefined,
          video_path: body.video_path !== undefined ? String(body.video_path) : undefined,
          title: body.title !== undefined ? String(body.title) : undefined,
          description: body.description !== undefined ? String(body.description) : undefined,
          max_comments: body.max_comments !== undefined ? Number(body.max_comments) : undefined,
          max_results: body.max_results !== undefined ? Number(body.max_results) : undefined,
          headless: body.headless !== undefined ? Boolean(body.headless) : undefined,
        }) };
      }],
      [/^POST \/api\/social\/schedule$/, async (_url, body) => {
        const platform = String(body.platform || '');
        if (!platform) throw new Error('platform is required (x, youtube)');
        const action = String(body.action || 'post');
        const email = String(body.email || '');
        const password = String(body.password || '');
        const scheduledAt = Number(body.scheduledAt || 0);
        if (!scheduledAt) throw new Error('scheduledAt is required (unix ms timestamp)');
        return { scheduled: await this.deps.socialSchedule({
          platform, action, email, password,
          text: body.text !== undefined ? String(body.text) : undefined,
          video_path: body.video_path !== undefined ? String(body.video_path) : undefined,
          title: body.title !== undefined ? String(body.title) : undefined,
          description: body.description !== undefined ? String(body.description) : undefined,
          scheduledAt,
        }) };
      }],
      [/^GET \/api\/social\/schedule$/, async () => ({ scheduled: await this.deps.socialScheduled() })],
      [/^POST \/api\/social\/cancel$/, async (_url, body) => {
        const id = String(body.id || '');
        if (!id) throw new Error('id is required');
        return { cancelled: await this.deps.socialCancelSchedule(id) };
      }],
      [/^GET \/api\/social\/status$/, async () => ({ social: await this.deps.socialStatus() })],
      // ── Smart Home (Samsung SmartThings) ─────────────────────
      [/^GET \/api\/smart\/status$/, async () => this.deps.smartStatus()],
      [/^GET \/api\/smart\/platforms$/, async () => ({ platforms: await this.deps.smartPlatforms() })],
      [/^POST \/api\/smart\/platforms\/([^/]+)\/connect$/, async (_url, body, match) => {
        const key = String(match?.[1] || '');
        const token = String(body.token || '').trim();
        if (!token) throw new Error('token is required');
        const url = body.url !== undefined ? String(body.url).trim() : undefined;
        return this.deps.smartConnectPlatform(key, token, url || undefined);
      }],
      [/^POST \/api\/smart\/platforms\/([^/]+)\/disconnect$/, async (_url, _body, match) =>
        this.deps.smartDisconnectPlatform(String(match?.[1] || ''))],
      [/^POST \/api\/smart\/token$/, async (_url, body) => {
        const token = String(body.token || '').trim();
        if (!token) throw new Error('token is required — paste your PAT from account.smartthings.com/tokens');
        return this.deps.smartSetToken(token);
      }],
      [/^DELETE \/api\/smart\/token$/, async () => this.deps.smartClearToken()],
      [/^GET \/api\/smart\/devices$/, async () => ({ devices: await this.deps.smartDevices() })],
      [/^POST \/api\/smart\/command$/, async (_url, body) => {
        const deviceId = String(body.deviceId || '');
        const command = body.command === 'on' ? 'on' : body.command === 'off' ? 'off' : '';
        if (!deviceId || !command) throw new Error('deviceId and command (on|off) are required');
        return { result: await this.deps.smartCommand(deviceId, command) };
      }],
      [/^POST \/api\/smart\/control$/, async (_url, body) => {
        const name = String(body.name || '');
        const command = body.command === 'on' ? 'on' : body.command === 'off' ? 'off' : '';
        if (!name || !command) throw new Error('name and command (on|off) are required');
        return { result: await this.deps.smartControlByName(name, command) };
      }],
      [/^GET \/api\/smart\/schedules$/, async () => ({ schedules: await this.deps.smartSchedules() })],
      [/^POST \/api\/smart\/schedules$/, async (_url, body) => {
        const deviceId = String(body.deviceId || '');
        const deviceName = String(body.deviceName || deviceId);
        const command = body.command === 'on' ? 'on' : body.command === 'off' ? 'off' : '';
        const kind = body.kind === 'at' ? 'at' : body.kind === 'everyMinutes' ? 'everyMinutes' : '';
        if (!deviceId || !command || !kind) throw new Error('deviceId, command (on|off) and kind (everyMinutes|at) are required');
        if (kind === 'everyMinutes' && !Number(body.everyMinutes)) throw new Error('everyMinutes is required for interval schedules');
        if (kind === 'at' && !/^\d{2}:\d{2}$/.test(String(body.at || ''))) throw new Error('at must be "HH:MM" for daily schedules');
        return { schedule: await this.deps.smartScheduleAdd({
          deviceId, deviceName, command,
          kind,
          everyMinutes: kind === 'everyMinutes' ? Number(body.everyMinutes) : undefined,
          at: kind === 'at' ? String(body.at) : undefined,
        }) };
      }],
      [/^POST \/api\/smart\/schedules\/cancel$/, async (_url, body) => {
        const id = String(body.id || '');
        if (!id) throw new Error('id is required');
        return { cancelled: await this.deps.smartScheduleCancel(id) };
      }],
      // ── Vault (credential store) ──────────────────────────────
      [/^GET \/api\/vault\/entries$/, async () => ({ entries: await this.deps.getVaultEntries() })],
      [/^POST \/api\/vault\/entry$/, async (_url, body) => {
        const service = String(body.service || '').trim();
        const username = body.username !== undefined ? String(body.username) : '';
        const secret = String(body.secret || '');
        const id = body.id !== undefined ? String(body.id) : undefined;
        return { entry: await this.deps.setVaultEntry({ service, username, secret, id }) };
      }],
      [/^DELETE \/api\/vault\/entry\/([\w-]+)$/, async (_url, _body, match) => ({ deleted: await this.deps.deleteVaultEntry(match![1]) })],
      // ── Carousel (Open Carrusel) ──────────────────────────────
      [/^POST \/api\/carrusel\/start$/, async () => ({ status: await this.deps.carruselStart() })],
      [/^POST \/api\/carrusel\/stop$/, async () => ({ status: await this.deps.carruselStop() })],
      [/^GET \/api\/carrusel\/status$/, async () => ({ status: await this.deps.carruselStatus() })],
      [/^POST \/api\/carrusel\/create$/, async (_url, body) => {
        const name = String(body.name || '').trim();
        if (!name) throw new Error('name is required');
        return { carousel: await this.deps.carruselCreate({ name, aspectRatio: body.aspectRatio !== undefined ? String(body.aspectRatio) : undefined }) };
      }],
      [/^GET \/api\/carrusel\/list$/, async () => ({ carousels: await this.deps.carruselList() })],
      // Must stay above GET /api/carrusel/:id — see routes/computer.ts.
      [/^GET \/api\/carrusel\/brand$/, async () => ({ brand: await this.deps.carruselBrand() })],
      [/^GET \/api\/carrusel\/([\w-]+)$/, async (_url, _body, match) => ({
        carousel: await this.deps.carruselGet(match![1]),
      })],
      [/^POST \/api\/carrusel\/([\w-]+)\/slides$/, async (_url, body, match) => {
        const html = String(body.html || '');
        if (!html) throw new Error('html is required (slide body HTML)');
        const note = body.note !== undefined ? String(body.note) : undefined;
        return { slide: await this.deps.carruselAddSlide({ carouselId: match![1], html, note }) };
      }],
      [/^POST \/api\/carrusel\/chat$/, async (_url, body) => {
        const message = String(body.message || '').trim();
        if (!message) throw new Error('message is required');
        const carouselId = body.carouselId !== undefined ? String(body.carouselId) : undefined;
        return { response: await this.deps.carruselChat({ message, carouselId }) };
      }],
      [/^POST \/api\/carrusel\/([\w-]+)\/export$/, async (_url, _body, match) => {
        const result = await this.deps.carruselExport(match![1]);
        return result;
      }],
      [/^DELETE \/api\/carrusel\/([\w-]+)$/, async (_url, _body, match) => ({
        deleted: await this.deps.carruselDelete(match![1]),
      })],
      [/^POST \/api\/carrusel\/([\w-]+)\/duplicate$/, async (_url, _body, match) => ({
        carousel: await this.deps.carruselDuplicate(match![1]),
      })],
      // ── Twenty CRM (GraphQL-driven) ──────────────────────────
      [/^POST \/api\/twenty\/start$/, async () => ({ status: await this.deps.twentyStart() })],
      [/^POST \/api\/twenty\/stop$/, async () => ({ status: await this.deps.twentyStop() })],
      [/^GET \/api\/twenty\/status$/, async () => ({ status: await this.deps.twentyStatus() })],
      [/^POST \/api\/twenty\/graphql$/, async (_url, body) => {
        const query = String(body.query || '').trim();
        if (!query) throw new Error('query is required (GraphQL query string)');
        const variables = (body.variables && typeof body.variables === 'object') ? body.variables as Record<string, unknown> : undefined;
        return { result: await this.deps.twentyGraphql({ query, variables }) };
      }],
      [/^POST \/api\/shutdown$/, async () => {
        this.deps.shutdown();
        return { ok: true };
      }],

      // ── Auth (web app accounts) ────────────────────────────────
      [/^POST \/api\/auth\/signup$/, async (_url, body) => {
        const email = String(body.email || '').trim();
        const password = String(body.password || '');
        const name = String(body.name || '').trim();
        if (!email || !password || !name) throw new Error('email, password, and name are required');
        return { user: await this.deps.authSignup(email, password, name) };
      }],
      [/^POST \/api\/auth\/login$/, async (_url, body) => {
        const email = String(body.email || '').trim();
        const password = String(body.password || '');
        if (!email || !password) throw new Error('email and password are required');
        return { user: await this.deps.authLogin(email, password) };
      }],
      [/^POST \/api\/auth\/login-key$/, async (url, body, _match, req) => {
        const apiKey = req
          ? this.resolveApiKey(req, url, body).key
          : String((body as any).apiKey || (body as any).api_key || '').trim();
        if (!apiKey) throw new Error('apiKey is required');
        return { user: await this.deps.authLoginWithKey(apiKey) };
      }],
      [/^GET \/api\/auth\/me$/, async (url, body, _match, req) => {
        const apiKey = req
          ? this.resolveApiKey(req, url, body).key
          : String(url.searchParams.get('key') || '').trim();
        if (!apiKey) throw new Error('API key required');
        return { user: await this.deps.authLoginWithKey(apiKey) };
      }],

      // ── Devices (pairing for web app) ──────────────────────────
      [/^GET \/api\/auth\/devices$/, async (url, body, _match, req) => {
        const apiKey = req
          ? this.resolveApiKey(req, url, body).key
          : String(url.searchParams.get('key') || (body as any).apiKey || (body as any).api_key || '').trim();
        if (!apiKey) throw new Error('API key required');
        return { devices: await this.deps.authListDevices(apiKey) };
      }],
      [/^POST \/api\/auth\/devices\/pair$/, async (url, body, _match, req) => {
        const resolved = req ? this.resolveApiKey(req, url, body).key : '';
        const apiKey = resolved || String((body as any).apiKey || (body as any).api_key || '').trim();
        const name = String(body.name || '').trim();
        const type = String(body.type || 'desktop');
        if (!apiKey || !name) throw new Error('apiKey and name are required');
        return { device: await this.deps.authPairDevice(apiKey, name, type) };
      }],
      [/^DELETE \/api\/auth\/devices\/([\w-]+)$/, async (url, body, match, req) => {
        const apiKey = req
          ? this.resolveApiKey(req, url, body).key
          : String(url.searchParams.get('key') || (body as any).apiKey || (body as any).api_key || '').trim();
        if (!apiKey) throw new Error('API key required');
        return { removed: await this.deps.authRemoveDevice(apiKey, match![1]) };
      }],

      // ── Plan (web app) ─────────────────────────────────────────
      [/^GET \/api\/auth\/plan$/, async (url, body, _match, req) => {
        const apiKey = req
          ? this.resolveApiKey(req, url, body).key
          : String(url.searchParams.get('key') || (body as any).apiKey || (body as any).api_key || '').trim();
        if (!apiKey) throw new Error('API key required');
        return { plan: await this.deps.authGetPlan(apiKey) };
      }],
      // Backwards compat: old paths still work but map to auth namespace
      [/^GET \/api\/plan$/, async (url, body, _match, req) => {
        const apiKey = req
          ? this.resolveApiKey(req, url, body).key
          : String(url.searchParams.get('key') || (body as any).apiKey || (body as any).api_key || '').trim();
        if (!apiKey) throw new Error('API key required');
        return { plan: await this.deps.authGetPlan(apiKey) };
      }],
    ];

    for (const [pattern, handler] of map) {
      const match = route.match(pattern);
      if (match) {
        return (url, body, _m, reqOverride) => handler(url, body, match, reqOverride ?? req);
      }
    }
    return null;
  }

  /**
   * Read a body as text (webhook signature verification needs the exact bytes).
   *
   * On overflow we do NOT `req.destroy()`: destroying the socket means the
   * client never sees the response, and closing a socket that still has unread
   * data in its receive buffer makes the kernel send RST — which also throws
   * away the 413 we just wrote. Instead we keep reading and discarding, then
   * answer 413 once the client has finished sending. `HARD_BODY_CEILING` bounds
   * that drain so an abusive client cannot stream forever.
   */
  private readRawBody(req: http.IncomingMessage): Promise<string> {
    return this.collectBody(req, true);
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return this.collectBody(req, false);
  }

  /** Shared body reader — see readRawBody() for the overflow strategy. */
  private collectBody(req: http.IncomingMessage, raw: boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      let overflow = false;
      const tooLarge = (): AppError =>
        new AppError(`Request body too large (max ${MAX_BODY_BYTES} bytes)`, 413);

      req.on('data', chunk => {
        if (overflow) {
          // Already over the cap — just count, so we know when to give up.
          if (data.length > HARD_BODY_CEILING) req.destroy();
          return;
        }
        data += chunk;
        if (data.length > MAX_BODY_BYTES) {
          overflow = true;
          data = ''; // stop holding the rejected payload in memory
          req.resume(); // drain the remainder so the 413 is not lost to a RST
        }
      });
      req.on('end', () => {
        if (overflow) { reject(tooLarge()); return; }
        if (raw) { resolve(data); return; }
        if (!data.trim()) { resolve({}); return; }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          reject(new AppError('Invalid JSON body', 400));
          return;
        }
        // Every route reads named fields off a plain object; an array or a
        // scalar is a client mistake, not a body we can dispatch on.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new AppError('Invalid JSON body: expected a JSON object', 400));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      });
      req.on('error', reject);
    });
  }

  private setCors(res: http.ServerResponse, req?: http.IncomingMessage): void {
    // Allowlist only — never '*'. Local UI origins by default; extend via
    // UMBRA_ALLOWED_ORIGINS="https://a,https://b" (comma-separated).
    const defaults = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
    ];
    const extra = (process.env['UMBRA_ALLOWED_ORIGINS'] || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const allowlist = new Set([...defaults, ...extra]);
    const origin = String(req?.headers?.origin || '').trim();
    if (origin && allowlist.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    // No ACAO header for non-allowlisted origins (browser blocks the read).
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Umbra-Tenant, X-Voicebox-Client-Id');
  }

  /**
   * Resolve the caller API key. Preferred: `Authorization: Bearer <key>`.
   * Compat: `?key=` query param and `body.apiKey/api_key/key` (kept, but the
   * query path emits a deprecation warning). Never logs the key value.
   *
   * Thin wrapper over the shared `resolveApiKey()` in `./apiKey` — the auth
   * sub-router in `routes/computer.ts` is matched ahead of the legacy map
   * below and calls the shared helper directly, so both paths must agree.
   */
  private resolveApiKey(
    req: http.IncomingMessage,
    url: URL,
    body?: Record<string, unknown>,
  ): { key: string; via: 'header' | 'query' | 'body' | 'none'; usedDeprecatedQuery: boolean } {
    return resolveApiKey(req, url, body);
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown, req?: http.IncomingMessage): void {
    // Belt-and-braces: the listeners are attached in guardConnection(), but a
    // caller may hold a res that never went through the request path.
    try { res.on('error', err => ApiServer.onSocketError(err)); } catch {}
    let text: string;
    try {
      text = JSON.stringify(payload);
    } catch (err) {
      getLogger().error({ err: (err as Error).message }, 'Response serialization failed');
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); } catch { /* ignore */ }
      this.endResponse(res, JSON.stringify({ error: 'Internal error' }), req);
      return;
    }
    try {
      // Client already gone — writing would raise EPIPE/ECONNRESET on Node 24.
      if (res.destroyed || res.writableEnded) return;
      if (req?.socket?.destroyed) return;
      const resSocket = (res as unknown as { socket?: { destroyed?: boolean } }).socket;
      if (resSocket?.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
    } catch (err) {
      ApiServer.onSocketError(err);
      try { res.destroy(); } catch {}
      return;
    }
    this.endResponse(res, text, req);
  }

  // ── WebSocket ─────────────────────────────────────────────

  private handleWsConnection(ws: WebSocket): void {
    this.clients.add(ws);

    this.deps.getStatus().then(status => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'snapshot', status })); } catch { /* client gone */ }
      }
    }).catch(() => { });

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  private broadcast(payload: Record<string, unknown>): void {
    const text = JSON.stringify(payload);
    // Snapshot the set: the loop prunes dead clients out of `this.clients`.
    for (const client of Array.from(this.clients)) {
      if (client.readyState !== WebSocket.OPEN) {
        // Prune dead sockets so a leaked client can't accumulate.
        try { this.clients.delete(client); } catch {}
        continue;
      }
      try { client.send(text); } catch {
        try { this.clients.delete(client); } catch {}
      }
    }
  }

  /** 1s coalesce window for high-frequency screen events (watch ticks + cursor). */
  private readonly SCREEN_COALESCE_MS = 1000;
  private lastScreenAt = 0;
  private pendingScreen: Record<string, unknown> | null = null;
  private pendingScreenTimer: NodeJS.Timeout | null = null;

  private broadcastThrottled(payload: Record<string, unknown>): void {
    const name = (payload as { name?: unknown }).name;
    if (name !== 'screen:update' && name !== 'screen:cursor') {
      this.broadcast(payload);
      return;
    }
    const now = Date.now();
    if (now - this.lastScreenAt >= this.SCREEN_COALESCE_MS) {
      this.lastScreenAt = now;
      this.broadcast(payload);
      return;
    }
    // Inside the window — keep only the latest, flush once the window ends.
    this.pendingScreen = payload;
    if (!this.pendingScreenTimer) {
      const delay = this.SCREEN_COALESCE_MS - (now - this.lastScreenAt);
      this.pendingScreenTimer = setTimeout(() => {
        this.pendingScreenTimer = null;
        const next = this.pendingScreen;
        this.pendingScreen = null;
        if (next) {
          this.lastScreenAt = Date.now();
          this.broadcast(next);
        }
      }, Math.max(0, delay));
      try { (this.pendingScreenTimer as unknown as { unref?: () => void }).unref?.(); } catch {}
    }
  }

  private busHandlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();

  private eventNames = [
    'app:ready', 'app:shutdown',
    'task:created', 'task:started', 'task:completed', 'task:failed', 'task:cancelled',
    'swarm:allocated', 'swarm:freed',
    'display:created', 'display:destroyed',
    'healing:recovered', 'healing:failed',
    'recall:macro-detected',
    'audio:gesture',
    'config:changed',
    'knowledge:updated',
    'vault:entry',
    'overlay:toggle', 'overlay:command',
    'stream:started', 'stream:stopped',      'screen:update', 'screen:cursor',
      'meeting:order', 'meeting:transcript',
      'chrome:telemetry',
    ] as const;

  private subscribeBus(): void {
    for (const name of this.eventNames) {
      const fn = (...args: unknown[]): void => {
        this.broadcastThrottled({ type: 'event', name, payload: args.length === 1 ? args[0] : args });
      };
      const list = this.busHandlers.get(name) || [];
      list.push(fn);
      this.busHandlers.set(name, list);
      eventBus.on(name as any, fn as any);
    }
  }

  private unsubscribeBus(): void {
    for (const name of this.eventNames) {
      const handlers = this.busHandlers.get(name);
      if (handlers) {
        for (const fn of handlers) eventBus.off(name as any, fn as any);
      }
    }
    this.busHandlers.clear();
    // Drop any coalesced screen frame — a stale cursor must not leak into
    // the next start() and confuse the first subscriber.
    if (this.pendingScreenTimer) {
      try { clearTimeout(this.pendingScreenTimer); } catch {}
      this.pendingScreenTimer = null;
    }
    this.pendingScreen = null;
  }
}

export default ApiServer;
