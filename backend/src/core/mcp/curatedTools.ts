/**
 * Curated tool schemas for the highest-value connectors.
 *
 * These give the LLM REAL parameter schemas and REAL endpoint templates for
 * the connectors people actually use, instead of the generic
 * `{endpoint, method, payload}` guessing shape — which is the single biggest
 * source of hallucinated API calls in the previous pipeline.
 *
 * A curated connector is matched to catalog entries by slugified name, so
 * `Gmail` matches `communication-gmail` wherever the category prefix puts it.
 * Connectors without a curated schema fall back to the generic shape and are
 * flagged `schema_quality: 'generic'` so retrieval prefers well-specified tools.
 *
 * Path placeholders in `endpointTemplate` (e.g. `{id}`) MUST also appear as
 * required string properties in `parameters` — the executor substitutes them
 * and validation enforces their presence before any request is built.
 */

import { ToolDefinition, JsonSchemaObject, makeToolId } from './ToolDefinition';

// ── Types ───────────────────────────────────────────────────────────

export interface CuratedConnector {
  /** Display name as (close to) it appears in the catalog. */
  name: string;
  /** Documented API base URL (no trailing slash). */
  baseUrl: string;
  authType: ToolDefinition['auth_type'];
  credentialService?: string;
  apiKeyHeader?: string;
  tools: CuratedTool[];
}

export interface CuratedTool {
  name: string;
  description: string;
  httpMethod: ToolDefinition['http_method'];
  /** Path template with {placeholders} for path parameters. */
  endpointTemplate: string;
  parameters: JsonSchemaObject;
}

// ── Reusable schema fragments ───────────────────────────────────────

const pathParam = (description: string) => ({
  type: 'string' as const,
  description: `Path parameter: ${description}`,
});

const maxResults = (n: number) => ({
  type: 'integer' as const,
  description: `Maximum number of results to return (default ${n}, max 100).`,
  default: n,
});

// ── Curated connectors ──────────────────────────────────────────────

export const CURATED_CONNECTORS: CuratedConnector[] = [
  {
    name: 'Gmail',
    baseUrl: 'https://gmail.googleapis.com',
    authType: 'oauth',
    credentialService: 'gmail',
    tools: [
      {
        name: 'send_message',
        description: 'Send an email message from the user\'s Gmail account.',
        httpMethod: 'POST',
        endpointTemplate: '/gmail/v1/users/me/messages/send',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Plain-text email body.' },
          },
          required: ['to', 'subject', 'body'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_messages',
        description: 'List messages in the user\'s Gmail mailbox, newest first.',
        httpMethod: 'GET',
        endpointTemplate: '/gmail/v1/users/me/messages',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Gmail search query (same syntax as the Gmail search box).' },
            maxResults: maxResults(25),
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'get_message',
        description: 'Get a single Gmail message including its body by ID.',
        httpMethod: 'GET',
        endpointTemplate: '/gmail/v1/users/me/messages/{id}',
        parameters: {
          type: 'object',
          properties: { id: pathParam('the Gmail message ID') },
          required: ['id'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Google Calendar',
    baseUrl: 'https://www.googleapis.com',
    authType: 'oauth',
    credentialService: 'google',
    tools: [
      {
        name: 'list_events',
        description: 'List calendar events within a time range on the primary calendar.',
        httpMethod: 'GET',
        endpointTemplate: '/calendar/v3/calendars/primary/events',
        parameters: {
          type: 'object',
          properties: {
            timeMin: { type: 'string', description: 'Range start as RFC3339 timestamp (e.g. 2026-01-01T00:00:00Z).' },
            timeMax: { type: 'string', description: 'Range end as RFC3339 timestamp.' },
            maxResults: maxResults(25),
            q: { type: 'string', description: 'Free-text search across event fields.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'create_event',
        description: 'Create an event on the primary Google Calendar.',
        httpMethod: 'POST',
        endpointTemplate: '/calendar/v3/calendars/primary/events',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Event title.' },
            start: { type: 'string', description: 'Start time as RFC3339 timestamp.' },
            end: { type: 'string', description: 'End time as RFC3339 timestamp.' },
            description: { type: 'string', description: 'Optional event description.' },
            location: { type: 'string', description: 'Optional location.' },
          },
          required: ['summary', 'start', 'end'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Google Drive',
    baseUrl: 'https://www.googleapis.com',
    authType: 'oauth',
    credentialService: 'google',
    tools: [
      {
        name: 'list_files',
        description: 'Search or list files in the user\'s Google Drive.',
        httpMethod: 'GET',
        endpointTemplate: '/drive/v3/files',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Drive search query, e.g. "name contains \'report\'".' },
            pageSize: maxResults(25),
          },
          required: [],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Google Sheets',
    baseUrl: 'https://sheets.googleapis.com',
    authType: 'oauth',
    credentialService: 'google',
    tools: [
      {
        name: 'get_values',
        description: 'Read a range of cells from a Google Sheet.',
        httpMethod: 'GET',
        endpointTemplate: '/v4/spreadsheets/{spreadsheetId}/values/{range}',
        parameters: {
          type: 'object',
          properties: {
            spreadsheetId: pathParam('the spreadsheet ID from its URL'),
            range: pathParam('A1 notation range, e.g. Sheet1!A1:C10'),
          },
          required: ['spreadsheetId', 'range'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Slack',
    baseUrl: 'https://slack.com',
    authType: 'bearer',
    credentialService: 'slack',
    tools: [
      {
        name: 'send_message',
        description: 'Post a message to a Slack channel, group, or DM.',
        httpMethod: 'POST',
        endpointTemplate: '/api/chat.postMessage',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel ID (C…), channel name (#general), or user ID for DMs.' },
            text: { type: 'string', description: 'Message text (supports Slack markup).' },
          },
          required: ['channel', 'text'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_channels',
        description: 'List Slack channels the bot/user can see.',
        httpMethod: 'GET',
        endpointTemplate: '/api/conversations.list',
        parameters: {
          type: 'object',
          properties: { limit: maxResults(50) },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'read_channel',
        description: 'Read recent messages from a Slack channel.',
        httpMethod: 'GET',
        endpointTemplate: '/api/conversations.history',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel ID to read.' },
            limit: maxResults(25),
          },
          required: ['channel'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Discord',
    baseUrl: 'https://discord.com',
    authType: 'bearer',
    credentialService: 'discord',
    tools: [
      {
        name: 'send_message',
        description: 'Send a message to a Discord channel.',
        httpMethod: 'POST',
        endpointTemplate: '/api/v10/channels/{channelId}/messages',
        parameters: {
          type: 'object',
          properties: {
            channelId: pathParam('the Discord channel ID'),
            content: { type: 'string', description: 'Message content (markdown supported).' },
          },
          required: ['channelId', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'read_channel',
        description: 'Read recent messages from a Discord channel.',
        httpMethod: 'GET',
        endpointTemplate: '/api/v10/channels/{channelId}/messages',
        parameters: {
          type: 'object',
          properties: {
            channelId: pathParam('the Discord channel ID'),
            limit: maxResults(25),
          },
          required: ['channelId'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Notion',
    baseUrl: 'https://api.notion.com',
    authType: 'bearer',
    credentialService: 'notion',
    tools: [
      {
        name: 'create_page',
        description: 'Create a page in Notion (optionally inside a parent page/database).',
        httpMethod: 'POST',
        endpointTemplate: '/v1/pages',
        parameters: {
          type: 'object',
          properties: {
            parent: { type: 'object', description: 'Parent object, e.g. {"page_id": "..."} or {"database_id": "..."}.' },
            title: { type: 'string', description: 'Page title.' },
            content: { type: 'string', description: 'Plain-text body placed as paragraph block.' },
          },
          required: ['parent', 'title'],
          additionalProperties: false,
        },
      },
      {
        name: 'query_database',
        description: 'Query a Notion database with optional filter/sort.',
        httpMethod: 'POST',
        endpointTemplate: '/v1/databases/{databaseId}/query',
        parameters: {
          type: 'object',
          properties: {
            databaseId: pathParam('the Notion database ID'),
            filter: { type: 'object', description: 'Notion filter object, e.g. {"property":"Status","select":{"equals":"Done"}}.' },
            pageSize: maxResults(25),
          },
          required: ['databaseId'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'GitHub',
    baseUrl: 'https://api.github.com',
    authType: 'bearer',
    credentialService: 'github',
    tools: [
      {
        name: 'list_issues',
        description: 'List issues for a GitHub repository.',
        httpMethod: 'GET',
        endpointTemplate: '/repos/{owner}/{repo}/issues',
        parameters: {
          type: 'object',
          properties: {
            owner: pathParam('repository owner (user or org)'),
            repo: pathParam('repository name'),
            state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter.' },
            per_page: maxResults(30),
          },
          required: ['owner', 'repo'],
          additionalProperties: false,
        },
      },
      {
        name: 'create_issue',
        description: 'Create an issue in a GitHub repository.',
        httpMethod: 'POST',
        endpointTemplate: '/repos/{owner}/{repo}/issues',
        parameters: {
          type: 'object',
          properties: {
            owner: pathParam('repository owner (user or org)'),
            repo: pathParam('repository name'),
            title: { type: 'string', description: 'Issue title.' },
            body: { type: 'string', description: 'Issue body (markdown).' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
          },
          required: ['owner', 'repo', 'title'],
          additionalProperties: false,
        },
      },
      {
        name: 'search_repositories',
        description: 'Search GitHub repositories by query.',
        httpMethod: 'GET',
        endpointTemplate: '/search/repositories',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query, e.g. "umbra language:typescript".' },
            per_page: maxResults(20),
          },
          required: ['q'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Spotify',
    baseUrl: 'https://api.spotify.com',
    authType: 'oauth',
    credentialService: 'spotify',
    tools: [
      {
        name: 'play',
        description: 'Start or resume playback, optionally with a specific context URI.',
        httpMethod: 'PUT',
        endpointTemplate: '/v1/me/player/play',
        parameters: {
          type: 'object',
          properties: {
            context_uri: { type: 'string', description: 'Spotify URI of album/playlist/artist to play (e.g. spotify:album:…).' },
            deviceId: { type: 'string', description: 'Target device ID (omitted = active device).' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'pause',
        description: 'Pause playback on the user\'s active device.',
        httpMethod: 'PUT',
        endpointTemplate: '/v1/me/player/pause',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'search',
        description: 'Search Spotify for tracks, albums, artists, or playlists.',
        httpMethod: 'GET',
        endpointTemplate: '/v1/search',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query.' },
            type: { type: 'string', enum: ['track', 'album', 'artist', 'playlist'], description: 'What to search for.' },
            limit: maxResults(10),
          },
          required: ['q', 'type'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Stripe',
    baseUrl: 'https://api.stripe.com',
    authType: 'bearer',
    credentialService: 'stripe',
    tools: [
      {
        name: 'list_charges',
        description: 'List recent Stripe charges.',
        httpMethod: 'GET',
        endpointTemplate: '/v1/charges',
        parameters: {
          type: 'object',
          properties: { limit: maxResults(20) },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'list_customers',
        description: 'List Stripe customers.',
        httpMethod: 'GET',
        endpointTemplate: '/v1/customers',
        parameters: {
          type: 'object',
          properties: {
            limit: maxResults(20),
            email: { type: 'string', description: 'Filter by exact customer email.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'create_customer',
        description: 'Create a Stripe customer.',
        httpMethod: 'POST',
        endpointTemplate: '/v1/customers',
        parameters: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Customer email.' },
            name: { type: 'string', description: 'Customer name.' },
          },
          required: ['email'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Twilio',
    baseUrl: 'https://api.twilio.com',
    authType: 'bearer',
    credentialService: 'twilio',
    tools: [
      {
        name: 'send_sms',
        description: 'Send an SMS message via Twilio.',
        httpMethod: 'POST',
        endpointTemplate: '/2010-04-01/Accounts/{accountSid}/Messages.json',
        parameters: {
          type: 'object',
          properties: {
            accountSid: pathParam('your Twilio Account SID (AC…)'),
            To: { type: 'string', description: 'Destination phone number in E.164 format.' },
            From: { type: 'string', description: 'Your Twilio number or messaging service sender.' },
            Body: { type: 'string', description: 'SMS text body.' },
          },
          required: ['accountSid', 'To', 'From', 'Body'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Twitter',
    baseUrl: 'https://api.twitter.com',
    authType: 'bearer',
    credentialService: 'twitter',
    tools: [
      {
        name: 'search_recent',
        description: 'Search recent tweets (last 7 days).',
        httpMethod: 'GET',
        endpointTemplate: '/2/tweets/search/recent',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (Twitter advanced syntax supported).' },
            max_results: maxResults(10),
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'post_tweet',
        description: 'Post a tweet as the authenticated user.',
        httpMethod: 'POST',
        endpointTemplate: '/2/tweets',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Tweet text (max 280 chars).' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Linear',
    baseUrl: 'https://api.linear.app',
    authType: 'bearer',
    credentialService: 'linear',
    tools: [
      {
        name: 'graphql',
        description: 'Execute a GraphQL query/mutation against the Linear API.',
        httpMethod: 'POST',
        endpointTemplate: '/graphql',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'GraphQL query or mutation string.' },
            variables: { type: 'object', description: 'GraphQL variables object.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Microsoft 365',
    baseUrl: 'https://graph.microsoft.com',
    authType: 'oauth',
    credentialService: 'microsoft',
    tools: [
      {
        name: 'send_mail',
        description: 'Send an email via Microsoft Graph (Outlook).',
        httpMethod: 'POST',
        endpointTemplate: '/v1.0/me/sendMail',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Subject line.' },
            body: { type: 'string', description: 'Plain-text body.' },
          },
          required: ['to', 'subject', 'body'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_mail',
        description: 'List the signed-in user\'s recent Outlook messages.',
        httpMethod: 'GET',
        endpointTemplate: '/v1.0/me/messages',
        parameters: {
          type: 'object',
          properties: {
            $top: maxResults(25),
            $search: { type: 'string', description: 'KQL search phrase, e.g. "project report".' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    name: 'Wikipedia',
    baseUrl: 'https://en.wikipedia.org',
    authType: 'none',
    tools: [
      {
        name: 'wikipedia_search',
        description: 'Search Wikipedia for articles matching a query; returns titles, page IDs, and snippets.',
        httpMethod: 'GET',
        endpointTemplate: '/w/api.php',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['query'], description: 'MediaWiki API action.' },
            list: { type: 'string', enum: ['search'], description: 'MediaWiki list type.' },
            srsearch: { type: 'string', description: 'Search text (what to look up on Wikipedia).' },
            format: { type: 'string', enum: ['json'], description: 'Response format.' },
            srlimit: { type: 'integer', description: 'Maximum number of results (1-50, default 5).', default: 5 },
          },
          required: ['action', 'list', 'srsearch', 'format'],
          additionalProperties: false,
        },
      },
    ],
  },
];

// ── Builders + lookup ───────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildCurated(): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const c of CURATED_CONNECTORS) {
    const connectorSlug = slug(c.name);
    // tool_id uses a stable pseudo-connector prefix; catalog matching happens
    // by connector slug, so the prefix is the canonical curated id.
    const connectorId = `curated-${connectorSlug}`;
    for (const t of c.tools) {
      const def: ToolDefinition = {
        tool_id: makeToolId(connectorId, t.name),
        connector_id: connectorId,
        name: t.name,
        natural_language_description: t.description,
        category: 'Curated',
        parameters_schema: t.parameters,
        auth_type: c.authType,
        transport: 'rest',
        endpoint_template: t.endpointTemplate,
        base_url: c.baseUrl,
        http_method: t.httpMethod,
        schema_quality: 'curated',
        source: 'curated',
      };
      if (c.credentialService) def.credential_service = c.credentialService;
      if (c.apiKeyHeader) def.api_key_header = c.apiKeyHeader;
      out.push(def);
    }
  }
  return out;
}

export const CURATED_TOOLS: ToolDefinition[] = buildCurated();

/** Catalog slug → curated connector (e.g. `communication-gmail` → Gmail's tools). */
const byCatalogSlug = new Map<string, CuratedConnector>();
for (const c of CURATED_CONNECTORS) {
  byCatalogSlug.set(slug(c.name), c);
}

/**
 * Find the curated connector matching a catalog entry id like
 * `communication-gmail` or `curated-github` (slug match on the last segment).
 */
export function curatedConnectorForCatalogId(catalogId: string): CuratedConnector | undefined {
  const last = catalogId.split('-').length > 1 ? catalogId : catalogId;
  void last; // (full-id form is matched directly below)
  if (byCatalogSlug.has(catalogId)) return byCatalogSlug.get(catalogId);
  // Walk suffixes: `communication-gmail` → `gmail`, `curated-google-drive` → `google-drive`
  const parts = catalogId.split('-');
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('-');
    const hit = byCatalogSlug.get(candidate);
    if (hit) return hit;
  }
  return undefined;
}

/** Curated ToolDefinitions that apply to a given catalog connector id. */
export function curatedToolsForCatalogId(catalogId: string): ToolDefinition[] {
  const c = curatedConnectorForCatalogId(catalogId);
  if (!c) return [];
  return CURATED_TOOLS.filter(t => t.base_url === c.baseUrl && sameConnector(t, c));
}

function sameConnector(t: ToolDefinition, c: CuratedConnector): boolean {
  return t.connector_id === `curated-${slug(c.name)}`;
}

export function curatedConnectorCount(): number {
  return CURATED_CONNECTORS.length;
}

export function curatedToolCount(): number {
  return CURATED_TOOLS.length;
}
