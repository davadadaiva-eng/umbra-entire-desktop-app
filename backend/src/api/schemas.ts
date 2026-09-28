/**
 * Backend-only API input schemas (zod, deterministic, no LLM).
 *
 * Purpose: turn silent `500 Internal error` crashes (missing/aliased fields)
 * into auditable `400` validation errors at the ApiServer boundary.
 * Mirrors the ad-hoc checks in `src/api/ApiServer.ts` and the canonical
 * `proposalSchema` pattern from `packages/domain` (discriminated, trimmed,
 * bounded strings) — but standalone so `backend` has zero new deps
 * (only `zod@^3`, already in package.json).
 *
 * Scope: task submit, desktop2 action, meeting execute/mute/chat,
 * connectors execute, social post-full, vault entry, telco sms/call,
 * docker run (+ auth apiKey/key alias helper). Desktop untouched.
 *
 * 14-mismatch map (frontend → backend canonical):
 *  M01 task.submit:        prompt|text|message|task → description (required)
 *  M02 desktop2.action:    command|type|name → action (required)
 *  M03 desktop2.action:    args|payload|body|data → params (object, default {})
 *  M04 meeting.execute:    command → action (required)
 *  M05 meeting.execute:    args|payload|body → params (object, default {})
 *  M06 meeting.mute:       mute|isMuted|is_muted → muted (loose boolean, default true)
 *  M07 meeting.chat:       text|body|content|chat → message (required)
 *  M08 connectors.execute: id|connector_id|connector → connectorId (required)
 *  M09 connectors.execute: body|data|params → payload (object, default {})  [payload vs body]
 *  M10 connectors.execute: path|route|url → endpoint; verb → method; user_id|user → userId
 *  M11 social.post-full:   platform+action+email+password required; username|login → email;
 *                          pass → password; action defaults to 'post'; camelCase mediaFiles|
 *                          videoPath|commentText|maxComments|maxResults → snake_case
 *  M12 vault.entry:        name|provider → service (required); password|value → secret (required);
 *                          user|login → username
 *  M13 telco sms/call:     phone|toNumber|recipient → to; message|body|content → text;
 *                          fromNumber|sender → from; url|callbackUrl → connectionUrl
 *  M14 docker.run + auth:  containerName → name; imageName → image; cmd → command;
 *                          environment → env; apiKey|api_key|key → apiKey (cross-cutting)
 */

import { z } from 'zod';

// ── Generic alias helpers ─────────────────────────────────────────────

type AliasMap = Record<string, string[]>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Copy first present alias into its canonical key (does not delete aliases; zod strips them). */
function normalizeAliases(raw: unknown, map: AliasMap): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [canonical, aliases] of Object.entries(map)) {
    if (out[canonical] !== undefined && out[canonical] !== null && out[canonical] !== '') continue;
    for (const a of aliases) {
      const val = (raw as Record<string, unknown>)[a];
      if (val !== undefined && val !== null && val !== '') {
        out[canonical] = val;
        break;
      }
    }
  }
  return out;
}

/** Loose boolean: accepts "true"/"false", 1/0, "on"/"off", "muted"/"unmuted". */
function toLooseBoolean(v: unknown): unknown {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '') return undefined;
    if (['true', '1', 'yes', 'y', 'on', 'muted', 'mute'].includes(s)) return true;
    if (['false', '0', 'no', 'n', 'off', 'unmuted', 'unmute'].includes(s)) return false;
    return v;
  }
  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
    return v;
  }
  return v;
}

function upperMethod(v: unknown): unknown {
  if (typeof v === 'string' && v.trim() !== '') return v.trim().toUpperCase();
  return v;
}

function lowerPlatform(v: unknown): unknown {
  if (typeof v === 'string') return v.trim().toLowerCase();
  return v;
}

// ── Shared primitives (zod v3 syntax) ─────────────────────────────────

const paramsRecord = z.record(z.string(), z.unknown());
const payloadRecord = z.record(z.string(), z.unknown());
const envRecord = z.record(z.string(), z.string());
const e164 = z.string().trim().min(1).max(50).regex(/^\+?[0-9\s\-().]+$/, 'Invalid phone number');

// ── 1. Task submit — POST /api/task ───────────────────────────────────
// ApiServer: description required, priority Number(body.priority || 0).
export const taskSubmitSchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      description: ['prompt', 'text', 'message', 'task', 'input'],
      priority: ['prio', 'urgency'],
    }),
  z.object({
    description: z.string().trim().min(1, 'description is required').max(12000),
    priority: z.coerce.number().int().min(0).max(100).default(0),
  }),
);
export type TaskSubmitInput = z.infer<typeof taskSubmitSchema>;

// ── 2. Desktop2 action — POST /api/desktop2/action ────────────────────
// ApiServer: action required, params object default {}.
export const desktop2ActionSchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      action: ['command', 'type', 'name', 'op'],
      params: ['args', 'payload', 'body', 'data', 'arguments'],
    }),
  z.object({
    action: z.string().trim().min(1, 'action is required').max(200),
    params: paramsRecord.default({}),
  }),
);
export type Desktop2ActionInput = z.infer<typeof desktop2ActionSchema>;

// ── 3. Meeting execute — POST /api/meeting/execute ───────────────────
export const meetingExecuteSchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      action: ['command', 'op', 'type', 'name'],
      params: ['args', 'payload', 'body', 'data', 'arguments'],
    }),
  z.object({
    action: z.string().trim().min(1, 'action is required').max(200),
    params: paramsRecord.default({}),
  }),
);
export type MeetingExecuteInput = z.infer<typeof meetingExecuteSchema>;

// ── 4. Meeting mute — POST /api/meeting/mute ─────────────────────────
// ApiServer: body.muted !== false (missing → muted). Accept mute/isMuted + strings.
export const meetingMuteSchema = z.preprocess(
  (v: unknown) => {
    const n = normalizeAliases(v, { muted: ['mute', 'isMuted', 'is_muted', 'is-muted'] });
    if ('muted' in n) n['muted'] = toLooseBoolean(n['muted']);
    return n;
  },
  z.object({
    muted: z.coerce.boolean().default(true),
  }),
);
export type MeetingMuteInput = z.infer<typeof meetingMuteSchema>;

// ── 5. Meeting chat — POST /api/meeting/chat ─────────────────────────
// ApiServer: message required.
export const meetingChatSchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      message: ['text', 'body', 'content', 'chat', 'msg'],
    }),
  z.object({
    message: z.string().trim().min(1, 'message is required').max(10000),
  }),
);
export type MeetingChatInput = z.infer<typeof meetingChatSchema>;

// ── 6. Connectors execute — POST /api/connectors/execute ─────────────
// ApiServer: connectorId required; endpoint default '/'; method default GET;
// payload object default {}; userId optional.
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export const connectorExecuteSchema = z.preprocess(
  (v: unknown) => {
    const n = normalizeAliases(v, {
      connectorId: ['id', 'connector_id', 'connector', 'connectorID', 'slug'],
      endpoint: ['path', 'route', 'url', 'target'],
      method: ['verb', 'httpMethod', 'http_method'],
      payload: ['body', 'data', 'params', 'args', 'input'],
      userId: ['user_id', 'user', 'uid'],
    });
    if (n['method'] !== undefined) n['method'] = upperMethod(n['method']);
    return n;
  },
  z.object({
    connectorId: z.string().trim().min(1, 'connectorId is required').max(200),
    endpoint: z.string().trim().min(1).max(2048).default('/'),
    method: z.enum(HTTP_METHODS).default('GET'),
    payload: payloadRecord.default({}),
    userId: z.string().trim().min(1).max(200).optional(),
  }),
);
export type ConnectorExecuteInput = z.infer<typeof connectorExecuteSchema>;

// ── 7. Social post-full — POST /api/social/post ──────────────────────
// ApiServer + SocialAutomation.SocialAction: platform/action/email/password;
// action defaults to 'post'. Full snake_case canonical; accept camelCase.
export const SOCIAL_PLATFORMS = ['x', 'youtube', 'instagram'] as const;
export const SOCIAL_ACTIONS = ['post', 'comment', 'search', 'upload', 'login'] as const;

export const socialPostFullSchema = z.preprocess(
  (v: unknown) => {
    const n = normalizeAliases(v, {
      platform: ['platformName', 'network', 'site', 'provider'],
      action: ['op', 'type', 'operation'],
      email: ['username', 'login', 'user', 'account', 'handle'],
      password: ['pass', 'passwd', 'pwd', 'secret'],
      text: ['content', 'message', 'body', 'caption', 'post_text'],
      comment_text: ['commentText', 'comment', 'comment_body'],
      query: ['q', 'search', 'searchQuery', 'search_query'],
      media_files: ['mediaFiles', 'media', 'images', 'attachments'],
      video_path: ['videoPath', 'video', 'videoFile', 'video_file'],
      title: ['videoTitle', 'video_title', 'name'],
      description: ['desc', 'videoDescription', 'video_description'],
      max_comments: ['maxComments', 'maxcomments', 'limit_comments'],
      max_results: ['maxResults', 'maxresults', 'limit'],
      headless: ['headlessMode', 'headless_mode'],
    });
    if (n['platform'] !== undefined) n['platform'] = lowerPlatform(n['platform']);
    if (n['action'] !== undefined && typeof n['action'] === 'string') {
      n['action'] = (n['action'] as string).trim().toLowerCase();
    }
    return n;
  },
  z.object({
    platform: z.enum(SOCIAL_PLATFORMS, {
      errorMap: () => ({ message: 'platform is required (x, youtube, instagram)' }),
    }),
    action: z.enum(SOCIAL_ACTIONS).default('post'),
    email: z.string().trim().min(1, 'email and password are required').max(254),
    password: z.string().min(1, 'email and password are required').max(500),
    text: z.string().max(10000).optional(),
    comment_text: z.string().max(10000).optional(),
    query: z.string().max(2000).optional(),
    media_files: z.array(z.string().min(1).max(2000)).max(10).optional(),
    video_path: z.string().min(1).max(2000).optional(),
    title: z.string().max(500).optional(),
    description: z.string().max(5000).optional(),
    max_comments: z.coerce.number().int().min(1).max(1000).optional(),
    max_results: z.coerce.number().int().min(1).max(1000).optional(),
    headless: z.coerce.boolean().optional(),
  }),
);
export type SocialPostFullInput = z.infer<typeof socialPostFullSchema>;

// ── 8. Vault entry — POST /api/vault/entry ───────────────────────────
// ApiServer currently String(body.service||'')/String(body.secret||'') with no
// throw → downstream 500 on empty. Schema enforces both + username aliases.
export const vaultEntrySchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      service: ['name', 'provider', 'account', 'serviceName', 'service_name'],
      username: ['user', 'login', 'accountName', 'account_name', 'email'],
      secret: ['password', 'value', 'secretValue', 'secret_value', 'token'],
      id: ['entryId', 'entry_id', 'vaultId'],
    }),
  z.object({
    service: z.string().trim().min(1, 'service is required').max(200),
    username: z.string().max(200).default(''),
    secret: z.string().min(1, 'secret is required').max(10000),
    id: z.string().trim().min(1).max(200).optional(),
  }),
);
export type VaultEntryInput = z.infer<typeof vaultEntrySchema>;

// ── 9. Telco SMS — POST /api/telco/sms ───────────────────────────────
// ApiServer: to + text required, from optional.
export const telcoSmsSchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      to: ['phone', 'toNumber', 'to_number', 'recipient', 'destination', 'number'],
      text: ['message', 'body', 'content', 'sms', 'msg'],
      from: ['fromNumber', 'from_number', 'sender', 'source'],
    }),
  z.object({
    to: e164,
    text: z.string().trim().min(1, 'to and text are required').max(1600),
    from: z.string().trim().min(1).max(50).optional(),
  }),
);
export type TelcoSmsInput = z.infer<typeof telcoSmsSchema>;

// ── 10. Telco call — POST /api/telco/call ────────────────────────────
// ApiServer: to required, from + connectionUrl optional.
export const telcoCallSchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      to: ['phone', 'toNumber', 'to_number', 'recipient', 'destination', 'number'],
      from: ['fromNumber', 'from_number', 'sender', 'source'],
      connectionUrl: ['connection_url', 'url', 'callbackUrl', 'callback_url', 'webhookUrl'],
    }),
  z.object({
    to: e164,
    from: z.string().trim().min(1).max(50).optional(),
    connectionUrl: z.string().trim().min(1).max(2048).optional(),
  }),
);
export type TelcoCallInput = z.infer<typeof telcoCallSchema>;

// ── 11. Docker run — POST /api/docker/run ────────────────────────────
// ApiServer: name + image required; command string[]; env record;
// memoryLimitMb + cpuQuotaPct numbers. Matches DockerDaemon.ContainerSpec.
export const dockerRunSchema = z.preprocess(
  (v: unknown) =>
    normalizeAliases(v, {
      name: ['containerName', 'container_name', 'container', 'id'],
      image: ['imageName', 'image_name', 'dockerImage', 'docker_image'],
      command: ['cmd', 'commands', 'args', 'runCommand'],
      env: ['environment', 'envVars', 'env_vars', 'envs'],
      memoryLimitMb: ['memory', 'memoryMb', 'memory_mb', 'memoryLimit', 'memMb'],
      cpuQuotaPct: ['cpu', 'cpuPct', 'cpu_pct', 'cpus', 'cpuQuota'],
    }),
  z.object({
    name: z
      .string()
      .trim()
      .min(1, 'name and image are required')
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'Invalid container name'),
    image: z.string().trim().min(1, 'name and image are required').max(500),
    command: z.array(z.string().min(1).max(2000)).max(100).optional(),
    env: envRecord.optional(),
    memoryLimitMb: z.coerce.number().int().min(16).max(32768).optional(),
    cpuQuotaPct: z.coerce.number().int().min(1).max(400).optional(),
  }),
);
export type DockerRunInput = z.infer<typeof dockerRunSchema>;

// ── 12. Auth key alias — apiKey vs key vs api_key ────────────────────
// Covers POST /api/auth/login-key (body.apiKey|api_key), GET /api/auth/me,
// /api/auth/devices, /api/auth/plan, /api/plan (?key=), DELETE with ?key=.
// Backend reads url.searchParams.get('key') on GETs but body.apiKey on POSTs.
export const authKeyBodySchema = z.preprocess(
  (v: unknown) => normalizeAliases(v, { apiKey: ['key', 'api_key', 'apiKey', 'token'] }),
  z.object({
    apiKey: z.string().trim().min(1, 'apiKey is required').max(500),
  }),
);
export type AuthKeyBodyInput = z.infer<typeof authKeyBodySchema>;

export const apiKeyQuerySchema = z.preprocess(
  (v: unknown) => normalizeAliases(v, { key: ['apiKey', 'api_key', 'token'] }),
  z.object({
    key: z.string().trim().min(1, 'API key required').max(500),
  }),
);
export type ApiKeyQueryInput = z.infer<typeof apiKeyQuerySchema>;

// ── Error formatting (400, not 500) ──────────────────────────────────

export function formatZodError(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Parse or throw a 400-style Error with joined issues (ApiServer catch → 400). */
export function parseRouteBody<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const res = schema.safeParse(raw ?? {});
  if (!res.success) throw new Error(formatZodError(res.error));
  return res.data as z.infer<S>;
}

/** Route → schema registry for future ApiServer wiring (no behavior change yet). */
export const routeSchemas = {
  'POST /api/task': taskSubmitSchema,
  'POST /api/desktop2/action': desktop2ActionSchema,
  'POST /api/meeting/execute': meetingExecuteSchema,
  'POST /api/meeting/mute': meetingMuteSchema,
  'POST /api/meeting/chat': meetingChatSchema,
  'POST /api/connectors/execute': connectorExecuteSchema,
  'POST /api/social/post': socialPostFullSchema,
  'POST /api/vault/entry': vaultEntrySchema,
  'POST /api/telco/sms': telcoSmsSchema,
  'POST /api/telco/call': telcoCallSchema,
  'POST /api/docker/run': dockerRunSchema,
  'POST /api/auth/login-key': authKeyBodySchema,
} as const;
