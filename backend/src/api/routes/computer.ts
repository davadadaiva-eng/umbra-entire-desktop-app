/**
 * Umbra OS — computer sub-router (extracted from ApiServer route map).
 * Owns MCP / connector marketplace, LLM + billing + tenants, Docker workers,
 * mesh + devices, auth, telco, carrusel and Twenty CRM routes.
 * Re-exported via ApiServer — routes remain identical. Internal order matches
 * the original ApiServer map so overlapping patterns (connectors search /
 * categories before :id; carrusel list before :id) keep their precedence.
 */
import type * as http from 'http';
import type { ApiServerDeps } from '../ApiServer';
import { resolveApiKey } from '../apiKey';

type Handler = (url: URL, body: Record<string, unknown>, match?: RegExpMatchArray, req?: http.IncomingMessage) => Promise<unknown>;
export type ComputerRouteEntry = [RegExp, Handler];

/**
 * Resolve the caller API key for an auth-namespace route.
 * Accepts `Authorization: Bearer <key>` (preferred), `?key=`, and
 * `body.apiKey | body.api_key | body.key`. The desktop client posts `{ key }`
 * (see `desktop/src/lib/backend.ts` authLoginKey / authPairDevice), so the
 * `key` alias is load-bearing, not cosmetic.
 */
function callerKey(
  req: http.IncomingMessage | undefined,
  url: URL,
  body: Record<string, unknown>,
): string {
  return resolveApiKey(req, url, body).key;
}

export function computerRoutes(deps: ApiServerDeps): ComputerRouteEntry[] {
  return [
    [/^GET \/api\/mcp\/catalog$/, async url => ({
      catalog: await deps.getMcpCatalog({
        q: url.searchParams.get('q') || undefined,
        category: url.searchParams.get('category') || undefined,
        enabled: url.searchParams.get('enabled') !== null ? url.searchParams.get('enabled') === 'true' : undefined,
        limit: url.searchParams.get('limit') !== null ? Number(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.get('offset') !== null ? Number(url.searchParams.get('offset')) : undefined,
      }),
    })],
    [/^GET \/api\/mcp\/connectors$/, async () => ({
      connectors: await deps.getMcpCatalog({ enabled: true }),
    })],
    [/^POST \/api\/mcp\/disconnect$/, async (_url, body) => {
      const id = String(body.id || '');
      if (!id) throw new Error('id is required');
      return { connector: await deps.disconnectMcp(id) };
    }],
    [/^POST \/api\/mcp\/import-registry$/, async (_url, body) => ({
      result: await deps.syncExternalSources({
        maxPerSource: body.maxPerSource !== undefined ? Number(body.maxPerSource) : undefined,
      }),
    })],
    [/^GET \/api\/connectors$/, async url => ({
      connectors: await deps.listConnectors({
        q: url.searchParams.get('q') || undefined,
        category: url.searchParams.get('category') || undefined,
        limit: url.searchParams.get('limit') !== null ? Number(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.get('offset') !== null ? Number(url.searchParams.get('offset')) : undefined,
      }),
    })],
    // Readiness routes MUST precede the `/api/connectors/([\w-]+)$` catch-all,
    // otherwise "readiness" is matched as a connector id.
    [/^GET \/api\/connectors\/readiness$/, async url => ({
      readiness: deps.getConnectorReadinessSummary(url.searchParams.get('userId') || undefined),
    })],
    [/^GET \/api\/connectors\/categories$/, async () => ({
      categories: await deps.getConnectorCategories(),
    })],
    [/^GET \/api\/connectors\/search$/, async url => ({
      connectors: await deps.listConnectors({
        q: url.searchParams.get('q') || undefined,
        category: url.searchParams.get('category') || undefined,
        limit: 50,
      }),
    })],
    [/^GET \/api\/connectors\/([\w-]+)$/, async (_url, _body, match) => ({
      connector: await deps.getConnector(match![1]),
    })],
    [/^POST \/api\/connectors\/([\w-]+)\/connect$/, async (_url, body, match) => {
      const id = match![1];
      return deps.connectConnector(id, {
        apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
        redirectUri: body.redirectUri !== undefined ? String(body.redirectUri) : undefined,
      });
    }],
    // OAuth completion leg for POST /connect — the authorize redirect targets
    // this route, so it must exist or the flow dead-ends on a 404.
    [/^GET \/api\/connectors\/([\w-]+)\/callback$/, async (url, _body, match) => {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      if (!code || !state) throw new Error('code and state are required');
      return { oauth: await deps.completeConnectorOauth(match![1], code, state) };
    }],
    [/^GET \/api\/connectors\/([\w-]+)\/status$/, async (url, _body, match) => ({
      status: await deps.getConnectorStatus(match![1], url.searchParams.get('userId') || undefined),
    })],
    // Tool-schema browser + on-demand ingestion. These live here (not the
    // legacy map) so the sub-router owns the full connector domain; the more
    // specific `/tools/schemas` path sits above the `([\w-]+)` patterns so a
    // future bare-`/tools` catch-all can never swallow it.
    [/^GET \/api\/connectors\/tools\/schemas$/, async url =>
      deps.listToolSchemas({
        q: url.searchParams.get('q') || undefined,
        connectorId: url.searchParams.get('connectorId') || undefined,
        limit: url.searchParams.get('limit') !== null ? Number(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.get('offset') !== null ? Number(url.searchParams.get('offset')) : undefined,
      })],
    [/^GET \/api\/connectors\/([\w-]+)\/tools$/, async (_url, _body, match) =>
      deps.getConnectorTools(match![1])],
    [/^POST \/api\/connectors\/ingest-openapi$/, async (_url, body) => {
      if (!body.connectorId) throw new Error('connectorId is required');
      if (body.spec === undefined && !body.specUrl) throw new Error('spec or specUrl is required');
      return deps.ingestConnectorOpenApi({
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
    // One-click enable for name-only catalog rows: ingest the connector's
    // known spec when it has no tools yet (idempotent — short-circuits when
    // already indexed). `force: true` re-ingests from the spec.
    [/^POST \/api\/connectors\/([\w-]+)\/ensure-tools$/, async (_url, body, match) => ({
      result: await deps.ensureConnectorTools(match![1], {
        ...(body.force !== undefined ? { force: body.force === true } : {}),
      }),
    })],
    [/^GET \/api\/connectors\/([\w-]+)\/readiness$/, async (url, _body, match) => ({
      readiness: deps.getConnectorReadiness(match![1], url.searchParams.get('userId') || undefined),
    })],
    [/^POST \/api\/connectors\/([\w-]+)\/disconnect$/, async (_url, _body, match) => ({
      result: await deps.disconnectConnectorApi(match![1]),
    })],
    [/^POST \/api\/connectors\/execute$/, async (_url, body) => {
      const connectorId = String(body.connectorId || '');
      const endpoint = String(body.endpoint || '/');
      const method = String(body.method || 'GET').toUpperCase();
      const payload = (body.payload && typeof body.payload === 'object') ? body.payload as Record<string, unknown> : {};
      const userId = body.userId !== undefined ? String(body.userId) : undefined;
      if (!connectorId) throw new Error('connectorId is required');
      return deps.executeConnectorAction(connectorId, endpoint, method, payload, userId);
    }],
    [/^POST \/api\/connectors\/tools$/, async (_url, body) => {
      const query = String(body.query || '');
      if (!query) throw new Error('query is required');
      const limit = body.limit !== undefined ? Number(body.limit) : undefined;
      return { tools: await deps.getRelevantTools(query, limit) };
    }],
    [/^POST \/api\/connectors\/sync$/, async () => ({
      result: await deps.syncConnectorCatalog(),
    })],
    [/^POST \/api\/connectors\/credential$/, async (_url, body) => {
      const slug = String(body.slug || '');
      if (!slug) throw new Error('slug is required');
      const clientId = String(body.clientId || body.client_id || '');
      const clientSecret = String(body.clientSecret || body.client_secret || '');
      const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
      return deps.saveConnectorCredential(slug, clientId, clientSecret, scopes);
    }],
    [/^GET \/api\/llm\/models$/, async () => deps.getModelStatus()],
    [/^GET \/api\/plan\/usage$/, async url => deps.getPlanUsage(url.searchParams.get('tenant') || undefined)],
    [/^POST \/api\/llm\/test$/, async () => deps.testLlm()],
    [/^GET \/api\/config\/provider$/, async () => deps.getProviderConfig()],
    [/^POST \/api\/plan\/activate$/, async (_url, body) => {
      const tier = String(body.tier || '');
      if (!tier) throw new Error('tier is required');
      const tenant = body.tenant !== undefined ? String(body.tenant) : undefined;
      return deps.activatePlan(tier, tenant);
    }],
    [/^GET \/api\/billing\/checkout$/, async url => {
      const tier = url.searchParams.get('tier') || '';
      if (!tier) throw new Error('tier is required');
      const tenant = url.searchParams.get('tenant') || undefined;
      return { checkout: await deps.billingCreateCheckout(tier, tenant) };
    }],
    [/^GET \/api\/tenants$/, async () => ({ tenants: await deps.tenantsList() })],
    [/^POST \/api\/tenants\/register$/, async (_url, body) => {
      const id = String(body.id || '').trim();
      if (!id) throw new Error('tenant id is required');
      return { tenant: await deps.tenantsRegister({
        id,
        name: body.name !== undefined ? String(body.name) : undefined,
        tier: body.tier !== undefined ? String(body.tier) : undefined,
      }) };
    }],
    [/^POST \/api\/tenants\/activate$/, async (_url, body) => {
      const id = String(body.id || '').trim();
      const tier = String(body.tier || '');
      if (!id || !tier) throw new Error('tenant id and tier are required');
      return { tenant: await deps.tenantsActivate(id, tier) };
    }],
    [/^POST \/api\/tenants\/disable$/, async (_url, body) => {
      const id = String(body.id || '').trim();
      if (!id) throw new Error('tenant id is required');
      return { tenant: await deps.tenantsDisable(id) };
    }],
    [/^POST \/api\/config\/provider$/, async (_url, body) => deps.configureProvider({
      provider: body.provider !== undefined ? String(body.provider) : undefined,
      endpoint: body.endpoint !== undefined ? String(body.endpoint) : undefined,
      apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
      models: body.models && typeof body.models === 'object' ? body.models as Record<string, string> : undefined,
      tier: body.tier !== undefined ? String(body.tier) : undefined,
    })],
    [/^POST \/api\/mcp\/connect$/, async (_url, body) => {
      const id = String(body.id || '');
      if (!id) throw new Error('id is required');
      const opts = {
        baseUrl: body.baseUrl !== undefined ? String(body.baseUrl) : undefined,
        apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
      };
      return { connector: await deps.connectMcp(id, opts) };
    }],
    [/^POST \/api\/mcp\/oauth\/start$/, async (_url, body) => {
      const id = String(body.id || '');
      if (!id) throw new Error('id is required');
      return { oauth: await deps.beginMcpOauth(id, body.redirectUri !== undefined ? String(body.redirectUri) : undefined) };
    }],
    [/^GET \/api\/mcp\/oauth\/callback$/, async url => {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      if (!code || !state) throw new Error('code and state are required');
      return { oauth: await deps.completeMcpOauth(code, state) };
    }],
    [/^GET \/api\/mcp\/oauth\/status$/, async url => {
      const id = url.searchParams.get('id') || '';
      if (!id) throw new Error('id is required');
      return { oauth: deps.getMcpOauthStatus(id) };
    }],
    [/^POST \/api\/mcp\/oauth\/refresh$/, async (_url, body) => {
      const id = String(body.id || '');
      if (!id) throw new Error('id is required');
      return { oauth: await deps.refreshMcpOauth(id) };
    }],
    [/^POST \/api\/mcp\/sync$/, async (_url, body) => {
      const maxPerSource = body.maxPerSource !== undefined ? Number(body.maxPerSource) : 100;
      return { sync: await deps.syncExternalConnectors({ maxPerSource }) };
    }],
    [/^GET \/api\/telco\/status$/, async () => deps.getTelcoStatus()],
    [/^POST \/api\/telco\/configure$/, async (_url, body) => ({
      telco: await deps.configureTelco({
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
      return { result: await deps.telcoSendSms({ to, text, from: body.from !== undefined ? String(body.from) : undefined }) };
    }],
    [/^POST \/api\/telco\/call$/, async (_url, body) => {
      const to = String(body.to || '');
      if (!to) throw new Error('to is required');
      return { result: await deps.telcoCall({
        to,
        from: body.from !== undefined ? String(body.from) : undefined,
        connectionUrl: body.connectionUrl !== undefined ? String(body.connectionUrl) : undefined,
      }) };
    }],
    [/^POST \/api\/docker\/run$/, async (_url, body) => {
      const name = String(body.name || '');
      const image = String(body.image || '');
      if (!name || !image) throw new Error('name and image are required');
      return { container: await deps.dockerRun({
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
      return { stopped: await deps.dockerStop(name) };
    }],
    [/^POST \/api\/docker\/remove$/, async (_url, body) => {
      const name = String(body.name || '');
      if (!name) throw new Error('name is required');
      return { removed: await deps.dockerRemove(name) };
    }],
    [/^GET \/api\/docker\/list$/, async () => ({ containers: await deps.dockerList() })],
    [/^GET \/api\/mesh\/status$/, async () => deps.getMeshStatus()],
    [/^POST \/api\/mesh\/pair$/, async (_url, body) => ({
      pair: await deps.meshPair(body.ttl !== undefined ? Number(body.ttl) : 120),
    })],
    [/^POST \/api\/mesh\/pair-demo$/, async () => ({ pair: await deps.meshPairDemo() })],
    [/^POST \/api\/mesh\/revoke$/, async (_url, body) => {
      const deviceId = String(body.deviceId || '');
      if (!deviceId) throw new Error('deviceId is required');
      return { revoked: await deps.meshRevoke(deviceId) };
    }],
    [/^GET \/api\/devices$/, async () => ({ devices: await deps.listDevices() })],
    [/^POST \/api\/devices\/invite$/, async (_url, body) => {
      const name = body.name !== undefined ? String(body.name) : '';
      return { invite: await deps.createDeviceInvite(name) };
    }],
    [/^POST \/api\/devices\/join$/, async (_url, body) => {
      const code = String(body.code || '');
      if (!code) throw new Error('code is required');
      const meta = {
        name: body.name !== undefined ? String(body.name) : 'Device',
        role: body.role !== undefined ? String(body.role) : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
      };
      return { join: await deps.joinDevice(code, meta) };
    }],
    [/^POST \/api\/devices\/revoke$/, async (_url, body) => {
      const deviceId = String(body.deviceId || '');
      if (!deviceId) throw new Error('deviceId is required');
      return { revoked: await deps.revokeDevice(deviceId) };
    }],
    [/^POST \/api\/devices\/send$/, async (_url, body) => {
      const deviceId = String(body.deviceId || '');
      if (!deviceId) throw new Error('deviceId is required');
      const msg = (body.msg && typeof body.msg === 'object') ? body.msg as Record<string, unknown> : {};
      return { sent: await deps.sendToDevice(deviceId, msg) };
    }],
    [/^POST \/api\/carrusel\/start$/, async () => ({ status: await deps.carruselStart() })],
    [/^POST \/api\/carrusel\/stop$/, async () => ({ status: await deps.carruselStop() })],
    [/^GET \/api\/carrusel\/status$/, async () => ({ status: await deps.carruselStatus() })],
    [/^POST \/api\/carrusel\/create$/, async (_url, body) => {
      const name = String(body.name || '').trim();
      if (!name) throw new Error('name is required');
      return { carousel: await deps.carruselCreate({ name, aspectRatio: body.aspectRatio !== undefined ? String(body.aspectRatio) : undefined }) };
    }],
    [/^GET \/api\/carrusel\/list$/, async () => ({ carousels: await deps.carruselList() })],
    // MUST stay above GET /api/carrusel/:id below — otherwise `brand` is
    // swallowed by the id pattern and the client gets `{ carousel }` instead of
    // `{ brand }`. Same precedence rule as `list` and `connectors/categories`.
    [/^GET \/api\/carrusel\/brand$/, async () => ({ brand: await deps.carruselBrand() })],
    [/^GET \/api\/carrusel\/([\w-]+)$/, async (_url, _body, match) => ({
      carousel: await deps.carruselGet(match![1]),
    })],
    [/^POST \/api\/carrusel\/([\w-]+)\/slides$/, async (_url, body, match) => {
      const html = String(body.html || '');
      if (!html) throw new Error('html is required (slide body HTML)');
      const note = body.note !== undefined ? String(body.note) : undefined;
      return { slide: await deps.carruselAddSlide({ carouselId: match![1], html, note }) };
    }],
    [/^POST \/api\/carrusel\/chat$/, async (_url, body) => {
      const message = String(body.message || '').trim();
      if (!message) throw new Error('message is required');
      const carouselId = body.carouselId !== undefined ? String(body.carouselId) : undefined;
      return { response: await deps.carruselChat({ message, carouselId }) };
    }],
    [/^POST \/api\/carrusel\/([\w-]+)\/export$/, async (_url, _body, match) => {
      const result = await deps.carruselExport(match![1]);
      return result;
    }],
    [/^DELETE \/api\/carrusel\/([\w-]+)$/, async (_url, _body, match) => ({
      deleted: await deps.carruselDelete(match![1]),
    })],
    [/^POST \/api\/carrusel\/([\w-]+)\/duplicate$/, async (_url, _body, match) => ({
      carousel: await deps.carruselDuplicate(match![1]),
    })],
    [/^POST \/api\/twenty\/start$/, async () => ({ status: await deps.twentyStart() })],
    [/^POST \/api\/twenty\/stop$/, async () => ({ status: await deps.twentyStop() })],
    [/^GET \/api\/twenty\/status$/, async () => ({ status: await deps.twentyStatus() })],
    [/^POST \/api\/twenty\/graphql$/, async (_url, body) => {
      const query = String(body.query || '').trim();
      if (!query) throw new Error('query is required (GraphQL query string)');
      const variables = (body.variables && typeof body.variables === 'object') ? body.variables as Record<string, unknown> : undefined;
      return { result: await deps.twentyGraphql({ query, variables }) };
    }],
    [/^POST \/api\/auth\/signup$/, async (_url, body) => {
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!email || !password || !name) throw new Error('email, password, and name are required');
      return { user: await deps.authSignup(email, password, name) };
    }],
    [/^POST \/api\/auth\/login$/, async (_url, body) => {
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      if (!email || !password) throw new Error('email and password are required');
      return { user: await deps.authLogin(email, password) };
    }],
    [/^POST \/api\/auth\/login-key$/, async (url, body, _match, req) => {
      const apiKey = callerKey(req, url, body);
      if (!apiKey) throw new Error('apiKey is required');
      return { user: await deps.authLoginWithKey(apiKey) };
    }],
    [/^GET \/api\/auth\/me$/, async (url, body, _match, req) => {
      const apiKey = callerKey(req, url, body);
      if (!apiKey) throw new Error('API key required');
      return { user: await deps.authLoginWithKey(apiKey) };
    }],
    [/^GET \/api\/auth\/devices$/, async (url, body, _match, req) => {
      const apiKey = callerKey(req, url, body);
      if (!apiKey) throw new Error('API key required');
      return { devices: await deps.authListDevices(apiKey) };
    }],
    [/^POST \/api\/auth\/devices\/pair$/, async (url, body, _match, req) => {
      const apiKey = callerKey(req, url, body);
      const name = String(body.name || '').trim();
      const type = String(body.type || 'desktop');
      if (!apiKey || !name) throw new Error('apiKey and name are required');
      return { device: await deps.authPairDevice(apiKey, name, type) };
    }],
    [/^DELETE \/api\/auth\/devices\/([\w-]+)$/, async (url, body, match, req) => {
      const apiKey = callerKey(req, url, body);
      if (!apiKey) throw new Error('API key required');
      return { removed: await deps.authRemoveDevice(apiKey, match![1]) };
    }],
    [/^GET \/api\/auth\/plan$/, async (url, body, _match, req) => {
      const apiKey = callerKey(req, url, body);
      if (!apiKey) throw new Error('API key required');
      return { plan: await deps.authGetPlan(apiKey) };
    }],
    // Backwards compat: old path still works but maps to the auth namespace
    [/^GET \/api\/plan$/, async (url, body, _match, req) => {
      const apiKey = callerKey(req, url, body);
      if (!apiKey) throw new Error('API key required');
      return { plan: await deps.authGetPlan(apiKey) };
    }],
  ];
}

export default computerRoutes;
