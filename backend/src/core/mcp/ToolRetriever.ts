/**
 * ToolRetriever — fast keyword + category matching to find the most
 * relevant connectors for an LLM user query.
 *
 * Prevents passing all 2000+ tool schemas directly to the LLM by
 * extracting only the top 3-5 relevant connectors based on intent.
 *
 * Zero-cost: no vector DB, no external API — pure keyword scoring
 * against the in-memory catalog.
 */

import { MCP_CATALOG, McpCatalogEntry } from './McpCatalog';

// ── Types ───────────────────────────────────────────────────────────

export interface ConnectorTool {
  /** Function name for LLM tool calling (e.g. `gmail_execute_action`). */
  name: string;
  /** Human-readable description for the LLM. */
  description: string;
  /** The connector slug/id in the catalog. */
  connectorId: string;
  /** Connector display name. */
  connectorName: string;
  /** Category for context. */
  category: string;
  /** Auth type — tells the LLM how credentials are attached. */
  authType: string;
  /** OpenAPI-compatible parameter schema. */
  parameters: {
    type: 'OBJECT';
    properties: {
      endpoint: { type: 'STRING'; description: string };
      method: { type: 'STRING'; enum: string[]; description: string };
      payload: { type: 'OBJECT'; description: string };
    };
    required: string[];
  };
}

export interface RetrievalOptions {
  /** Max tools to return (default: 5). */
  limit?: number;
  /** Filter by category. */
  category?: string;
  /** Only include connectors the user has connected. */
  connectedOnly?: boolean;
  /** User ID for connection filtering. */
  userId?: string;
}

// ── Popularity ranking (well-known consumer/SaaS services first) ────
// Higher number = more popular. Unknown connectors default to 0.

const POPULARITY: Record<string, number> = {
  // Tier 1 — everyday essentials (90-100)
  'gmail': 100, 'google-calendar': 98, 'google-drive': 97, 'google-sheets': 96,
  'google-docs': 95, 'google-slides': 94, 'google-contacts': 93,
  'outlook': 99, 'microsoft-365': 97, 'onedrive': 95, 'microsoft-teams': 94,
  'microsoft-excel': 93, 'microsoft-word': 92,
  'slack': 99, 'discord': 98, 'telegram': 97, 'whatsapp': 96,
  'notion': 98, 'airtable': 95, 'trello': 93, 'asana': 94, 'monday': 93,
  'jira': 94, 'confluence': 92, 'linear': 91,
  'github': 99, 'gitlab': 95, 'bitbucket': 91, 'docker': 93, 'vercel': 92,
  'netlify': 90, 'heroku': 88,

  // Tier 2 — popular SaaS (70-89)
  'stripe': 89, 'paypal': 88, 'square': 85, 'shopify': 87,
  'salesforce': 88, 'hubspot': 87, 'zendesk': 86, 'intercom': 84,
  'twilio': 86, 'sendgrid': 85, 'mailgun': 83, 'postmark': 80,
  'twitter': 89, 'facebook': 88, 'instagram': 87, 'linkedin': 86,
  'youtube': 88, 'tiktok': 85, 'reddit': 84, 'pinterest': 82,
  'dropbox': 86, 'box': 82, 'icloud': 83,
  'aws': 89, 'azure': 87, 'gcp': 88, 'cloudflare': 86,
  'datadog': 84, 'new-relic': 83, 'sentry': 85, 'pagerduty': 83,
  'snowflake': 84, 'bigquery': 83, 'databricks': 82, 'looker': 81,
  'figma': 87, 'canva': 85, 'adobe': 84,
  'zoom': 88, 'webex': 83, 'meet': 84,
  'calendly': 86, 'doodle': 82,
  'airbnb': 85, 'uber': 86, 'lyft': 83,
  'spotify': 88, 'apple-music': 84, 'netflix': 85,
  'supabase': 86, 'firebase': 87, 'mongodb': 85, 'postgres': 84,
  'redis': 83, 'elasticsearch': 82,

  // Tier 3 — known services (50-69)
  'twitch': 69, 'snapchat': 68, 'mastodon': 65,
  'coinbase': 68, 'binance': 67, 'kraken': 65,
  'houzz': 60, 'etsy': 68, 'ebay': 67,
  'coda': 70,
  'gitbook': 68, 'readme': 65,
  'launchdarkly': 66, 'split': 64,
  'segment': 67, 'amplitude': 66, 'mixpanel': 65,
  'hotjar': 65, 'fullstory': 64, 'logrocket': 63,
  'ifttt': 82,
};

// Categories to exclude (AI/LLM providers — the user already HAS an AI)
const AI_CATEGORIES = new Set(['AI & ML']);

// Also exclude specific AI-related connector IDs even if in other categories
const AI_CONNECTOR_IDS = new Set([
  'developer-openai', 'developer-anthropic', 'developer-hugging-face',
  'developer-cohere', 'developer-stability-ai', 'developer-replicate',
  'developer-midjourney', 'developer-deepseek', 'developer-groq',
  'developer-mistral', 'developer-ai21', 'developer-fireworks',
  'developer-together', 'developer-openai-audio',
  'ai-openai', 'ai-anthropic', 'ai-hugging-face', 'ai-cohere',
  'ai-stability-ai', 'ai-replicate', 'ai-midjourney', 'ai-deepseek',
]);

// ── Stop words & scoring weights ────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'was', 'are',
  'be', 'has', 'had', 'have', 'will', 'can', 'do', 'does', 'did', 'get',
  'make', 'send', 'create', 'show', 'find', 'search', 'look', 'use',
  'want', 'need', 'please', 'could', 'would', 'should', 'may', 'might',
]);

/** Boost words that signal connector intent. */
const INTENT_BOOSTS: Record<string, number> = {
  // Action verbs → higher weight
  'send': 2.0, 'email': 2.5, 'post': 2.0, 'upload': 2.0, 'download': 2.0,
  'create': 1.8, 'delete': 1.5, 'update': 1.5, 'read': 1.2, 'write': 1.5,
  'search': 1.8, 'find': 1.5, 'list': 1.2, 'get': 1.0, 'fetch': 1.5,
  'play': 2.0, 'pause': 1.5, 'stop': 1.5, 'skip': 1.5,
  'schedule': 2.0, 'remind': 2.0, 'notify': 2.0,
  'track': 1.5, 'monitor': 1.5, 'analyze': 1.8,
  'buy': 2.0, 'sell': 2.0, 'pay': 2.0, 'charge': 2.0, 'invoice': 2.0,
  'deploy': 2.0, 'build': 1.5, 'test': 1.5, 'run': 1.2,
  'invite': 2.0, 'join': 1.5, 'leave': 1.5, 'kick': 1.5,
  'follow': 1.5, 'like': 1.5, 'comment': 1.5, 'share': 1.5,
  'backup': 2.0, 'sync': 1.8, 'export': 1.8, 'import': 1.8,
};

// ── Scoring functions ───────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function scoreConnector(query: string, connector: McpCatalogEntry): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const nameTokens = tokenize(connector.name);
  const descTokens = tokenize(connector.description);
  const catTokens = tokenize(connector.category);
  const idTokens = tokenize(connector.id);

  let score = 0;

  for (const qt of queryTokens) {
    // Exact name match (highest signal)
    if (nameTokens.includes(qt)) score += 10;
    // ID/slug match
    if (idTokens.includes(qt)) score += 8;
    // Description match
    if (descTokens.includes(qt)) score += 3;
    // Category match
    if (catTokens.includes(qt)) score += 5;

    // Partial / substring matches
    for (const nt of nameTokens) {
      if (nt.includes(qt) || qt.includes(nt)) score += 4;
    }
    for (const it of idTokens) {
      if (it.includes(qt) || qt.includes(it)) score += 3;
    }

    // Intent boost
    if (INTENT_BOOSTS[qt]) score += INTENT_BOOSTS[qt];
  }

  // Bonus: connectors with base URLs are more likely to be callable
  if (connector.baseUrl) score += 2;

  // Bonus: verified connectors
  if (connector.kind === 'verified') score += 1;

  return score;
}

function buildToolParams(): ConnectorTool['parameters'] {
  return {
    type: 'OBJECT',
    properties: {
      endpoint: {
        type: 'STRING',
        description: 'API endpoint route to hit (e.g. "/v1/messages", "/api/users/me")',
      },
      method: {
        type: 'STRING',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        description: 'HTTP method for the request',
      },
      payload: {
        type: 'OBJECT',
        description: 'JSON payload for request body (POST/PUT/PATCH) or query parameters (GET)',
      },
    },
    required: ['endpoint', 'method'],
  };
}

// ── ToolRetriever ───────────────────────────────────────────────────

export class ToolRetriever {
  /**
   * Find the most relevant tools for a user query.
   *
   * @param userQuery - Natural language description of what the user wants
   * @param options - Retrieval options (limit, category, connectedOnly)
   * @returns Top N relevant connector tools, sorted by relevance
   */
  getRelevantTools(
    userQuery: string,
    options: RetrievalOptions = {},
  ): ConnectorTool[] {
    const limit = options.limit ?? 5;
    const catalog = options.category
      ? MCP_CATALOG.filter(c => c.category === options.category)
      : MCP_CATALOG;

    // Score all connectors
    const scored = catalog
      .map(connector => ({
        connector,
        score: scoreConnector(userQuery, connector),
      }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Take top N
    const top = scored.slice(0, limit);

    return top.map(({ connector }) => ({
      name: `${connector.id.replace(/-/g, '_')}_execute_action`,
      description: connector.description || `Execute actions on ${connector.name}`,
      connectorId: connector.id,
      connectorName: connector.name,
      category: connector.category,
      authType: connector.authType,
      parameters: buildToolParams(),
    }));
  }

  /**
   * Search connectors by text (for marketplace UI).
   * Returns full catalog entries, not tool wrappers.
   * Sorted by popularity when no query; AI providers are excluded.
   */
  searchConnectors(
    query: string,
    options: { category?: string; limit?: number; offset?: number } = {},
  ): McpCatalogEntry[] {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    // Filter out AI categories and specific AI connector IDs
    let catalog = MCP_CATALOG.filter(c => !AI_CATEGORIES.has(c.category) && !AI_CONNECTOR_IDS.has(c.id));

    if (options.category) {
      catalog = catalog.filter(c => c.category === options.category);
    }

    if (query) {
      const scored = catalog
        .map(c => ({ c, score: scoreConnector(query, c) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);
      catalog = scored.map(s => s.c);
    } else {
      // Sort by popularity (highest first), then alphabetically for ties
      catalog = catalog
        .map(c => ({ c, pop: POPULARITY[c.id] ?? POPULARITY[c.credentialKey ?? ''] ?? 0 }))
        .sort((a, b) => b.pop - a.pop || a.c.name.localeCompare(b.c.name))
        .map(s => s.c);
    }

    return catalog.slice(offset, offset + limit);
  }

  /**
   * Get connectors by category (for marketplace filtering).
   * Excludes AI & ML category.
   */
  getCategories(): { category: string; count: number }[] {
    const map = new Map<string, number>();
    for (const c of MCP_CATALOG) {
      if (AI_CATEGORIES.has(c.category)) continue;
      map.set(c.category, (map.get(c.category) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get a single connector by ID.
   */
  getConnector(id: string): McpCatalogEntry | undefined {
    return MCP_CATALOG.find(c => c.id === id);
  }

  /**
   * Format tools for OpenAI/Gemini function calling.
   */
  toFunctionDeclarations(tools: ConnectorTool[]): Array<{
    name: string;
    description: string;
    parameters: ConnectorTool['parameters'];
  }> {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}
