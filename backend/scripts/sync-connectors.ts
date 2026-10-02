/**
 * sync-connectors — Fetches connector definitions from APIs.guru and
 * Activepieces GitHub, deduplicates against the hardcoded MCP_CATALOG,
 * and writes ExternalCatalog.json for runtime import.
 *
 * Usage:
 *   npx ts-node scripts/sync-connectors.ts
 *
 * The generated file is safe to commit — it's a static snapshot, not a
 * runtime dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// ── Types ───────────────────────────────────────────────────────────

interface ExternalCatalogEntry {
  id: string;
  name: string;
  category: string;
  baseUrl: string;
  authType: 'none' | 'bearer' | 'apiKey' | 'oauth';
  apiKeyHeader?: string;
  credentialKey?: string;
  tool?: string;
  kind: 'verified' | 'template';
  description: string;
  docs?: string;
  /** OpenAPI/Swagger spec URL (APIs.guru) — lets the runtime ingest tools. */
  specUrl?: string;
}

interface ApisGuruList {
  [key: string]: {
    preferred: string;
    versions: {
      [version: string]: {
        info: {
          title: string;
          description?: string;
          'x-logo'?: { url: string };
          'x-providerName'?: string;
        };
        swaggerUrl: string;
        specUrl: string;
      };
    };
  };
}

interface ActivepiecesPiece {
  name: string;
  displayName: string;
  description: string;
  logoUrl?: string;
  categories?: string[];
  auth?: {
    type: string;
    required: boolean;
    authUrl?: string;
    tokenUrl?: string;
    scope?: string[];
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function inferAuthType(security: any[]): 'oauth' | 'bearer' | 'apiKey' | 'none' {
  if (!security || security.length === 0) return 'none';
  for (const s of security) {
    if (s.oauth2) return 'oauth';
    if (s.bearerAuth || s.http) return 'bearer';
    if (s.apiKey) return 'apiKey';
  }
  return 'none';
}

function inferAuthHeader(security: any[], authType: string): string | undefined {
  if (authType === 'bearer') return 'Authorization';
  if (authType === 'oauth2') return 'Authorization';
  if (authType === 'apiKey') {
    for (const s of security) {
      if (s.apiKey?.in === 'header') return s.apiKey.name || 'X-API-Key';
    }
    return 'X-API-Key';
  }
  return undefined;
}

function guessCategory(title: string, providerName: string): string {
  const t = `${title} ${providerName}`.toLowerCase();
  if (/google|microsoft|office|outlook|onedrive|sharepoint|teams/.test(t)) return 'Productivity';
  if (/slack|discord|telegram|whatsapp|signal|messaging/.test(t)) return 'Communication';
  if (/github|gitlab|bitbucket|devops|ci|cd|jenkins/.test(t)) return 'Developer';
  if (/stripe|paypal|square|adyen|payment|billing/.test(t)) return 'Payments & Finance';
  if (/aws|azure|gcp|cloud|docker|kubernetes|terraform/.test(t)) return 'Cloud & DevOps';
  if (/salesforce|hubspot|crm|zendesk|intercom/.test(t)) return 'CRM & Marketing';
  if (/spotify|netflix|youtube|twitch|music|video|media/.test(t)) return 'Voice & Media';
  if (/twitter|x\.com|reddit|facebook|instagram|social/.test(t)) return 'Social Media';
  if (/shopify|amazon|ebay|etsy|ecommerce|commerce/.test(t)) return 'E-commerce & Retail';
  if (/notion|trello|asana|jira|linear|monday|todoist/.test(t)) return 'Project Management';
  if (/openai|anthropic|huggingface|ai|ml|model/.test(t)) return 'AI & ML';
  if (/fitbit|strava|health|fitness|whoop|garmin/.test(t)) return 'Health & Fitness';
  if (/weather|maps|geocoding|travel|flight|hotel/.test(t)) return 'Travel & Hospitality';
  if (/database|sql|mongo|redis|postgres|mysql/.test(t)) return 'Data & Analytics';
  return 'Other';
}

// ── APIs.guru Sync ──────────────────────────────────────────────────

async function fetchApisGuruCatalog(): Promise<ExternalCatalogEntry[]> {
  console.log('[Sync] Fetching APIs.guru catalog...');
  const { data: catalog } = await axios.get<ApisGuruList>(
    'https://api.apis.guru/v2/list.json',
    { timeout: 60_000 },
  );

  const entries = Object.entries(catalog);
  console.log(`[Sync] Processing ${entries.length} APIs.guru entries...`);

  const results: ExternalCatalogEntry[] = [];

  for (const [providerKey, providerData] of entries) {
    try {
      const preferredVer = providerData.preferred;
      const apiInfo = providerData.versions[preferredVer];
      if (!apiInfo) continue;

      const title = apiInfo.info.title || providerKey;
      const id = `apisguru-${slug(providerKey)}`;
      const baseUrl = '';
      const description = (apiInfo.info.description || `Integration for ${title}`).slice(0, 500);
      const category = guessCategory(title, providerKey);

      // Infer auth type from provider name (fast heuristic, no spec fetch)
      let authType: 'oauth' | 'bearer' | 'apiKey' | 'none' = 'apiKey';
      let apiKeyHeader: string | undefined = 'X-API-Key';

      const lowerKey = providerKey.toLowerCase();
      const lowerTitle = title.toLowerCase();
      if (/google|microsoft|github|dropbox|slack|spotify|figma|notion|linear|twitch|reddit|box|evernote/.test(lowerKey) || /google|microsoft|github|dropbox|slack|spotify|figma|notion|linear|twitch|reddit|box|evernote/.test(lowerTitle)) {
        authType = 'oauth';
        apiKeyHeader = 'Authorization';
      } else if (/^(aws|stripe|sendgrid|twilio|mailgun|algolia|datadog|sentry|planetscale|neon|cloudflare|vercel|netlify)/.test(lowerKey)) {
        authType = 'bearer';
        apiKeyHeader = 'Authorization';
      }

      results.push({
        id,
        name: title,
        category,
        baseUrl,
        authType,
        apiKeyHeader,
        credentialKey: slug(providerKey),
        kind: 'verified',
        description,
        // Persist the spec URL so the runtime can ingest real tools on demand
        // instead of leaving this row as a name-only catalog entry.
        specUrl: apiInfo.specUrl || apiInfo.swaggerUrl,
      });
    } catch (err) {
      // Skip individual entry errors silently
    }
  }

  console.log(`[Sync] APIs.guru: ${results.length} connectors extracted`);
  return results;
}

// ── Activepieces Sync ───────────────────────────────────────────────

async function fetchActivepiecesCatalog(): Promise<ExternalCatalogEntry[]> {
  console.log('[Sync] Fetching Activepieces pieces from GitHub...');

  try {
    // Fetch the list of piece directories from the GitHub API
    const { data: tree } = await axios.get(
      'https://api.github.com/repos/activepieces/activepieces/git/trees/main?recursive=1',
      { timeout: 30_000 },
    );

    // Find all piece metadata files (piece-metadata.json or similar)
    const pieceFiles = (tree.tree || []).filter((f: any) =>
      f.path?.match(/pieces\/[^/]+\/src\/lib\/common\/piece-metadata\.json$/)
    );

    console.log(`[Sync] Found ${pieceFiles.length} Activepieces piece definitions`);

    const results: ExternalCatalogEntry[] = [];

    // Fetch each piece metadata (batch to avoid rate limits)
    for (const file of pieceFiles.slice(0, 500)) {
      try {
        const { data: piece } = await axios.get(
          `https://raw.githubusercontent.com/activepieces/activepieces/main/${file.path}`,
          { timeout: 10_000 },
        );

        if (!piece?.name) continue;

        const id = `activepieces-${slug(piece.name)}`;
        const authType = piece.auth?.type === 'OAUTH2' ? 'oauth'
          : piece.auth?.type === 'API_KEY' ? 'apiKey'
          : 'none';

        results.push({
          id,
          name: piece.displayName || piece.name,
          category: piece.categories?.[0] || guessCategory(piece.displayName || piece.name, ''),
          baseUrl: '',
          authType,
          apiKeyHeader: authType === 'apiKey' ? 'X-API-Key' : undefined,
          credentialKey: `activepieces-${slug(piece.name)}`,
          kind: 'verified',
          description: (piece.description || `Activepieces integration: ${piece.name}`).slice(0, 500),
          docs: `https://www.activepieces.com/pieces/${piece.name}`,
        });
      } catch {
        // Skip individual piece errors
      }
    }

    console.log(`[Sync] Activepieces: ${results.length} connectors extracted`);
    return results;
  } catch (err) {
    console.warn('[Sync] Activepieces sync failed (GitHub rate limit?):', (err as Error).message);
    return [];
  }
}

// ── n8n Node Registry Sync ─────────────────────────────────────────

async function fetchN8nCatalog(): Promise<ExternalCatalogEntry[]> {
  console.log('[Sync] Fetching n8n node registry from GitHub...');

  try {
    const { data: tree } = await axios.get(
      'https://api.github.com/repos/n8n-io/n8n/git/trees/master?recursive=1',
      { timeout: 30_000 },
    );

    // Find package.json files under packages/nodes-base/nodes/
    const nodeFiles = (tree.tree || []).filter((f: any) =>
      f.path?.match(/packages\/nodes-base\/nodes\/[^/]+\/[^/]+\.node\.ts$/)
    );

    console.log(`[Sync] Found ${nodeFiles.length} n8n node definitions`);

    const results: ExternalCatalogEntry[] = [];

    for (const file of nodeFiles.slice(0, 500)) {
      try {
        const match = file.path.match(/nodes\/([^/]+)\//);
        if (!match) continue;

        const nodeName = match[1];
        const id = `n8n-${slug(nodeName)}`;

        results.push({
          id,
          name: nodeName.replace(/([A-Z])/g, ' $1').trim(),
          category: guessCategory(nodeName, 'n8n'),
          baseUrl: '',
          authType: 'apiKey',
          apiKeyHeader: 'X-N8N-API-KEY',
          credentialKey: `n8n-${slug(nodeName)}`,
          kind: 'verified',
          description: `n8n automation node for ${nodeName}`,
          docs: `https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.${nodeName}/`,
        });
      } catch {
        // Skip individual node errors
      }
    }

    console.log(`[Sync] n8n: ${results.length} connectors extracted`);
    return results;
  } catch (err) {
    console.warn('[Sync] n8n sync failed:', (err as Error).message);
    return [];
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // Load existing hardcoded catalog IDs for deduplication
  const existingCatalogPath = path.resolve(__dirname, '../src/core/mcp/McpCatalog.ts');
  const existingContent = fs.readFileSync(existingCatalogPath, 'utf-8');
  const existingIds = new Set<string>();
  const idMatches = existingContent.matchAll(/id:\s*`([^`]+)`/g);
  for (const m of idMatches) existingIds.add(m[1]);

  console.log(`[Sync] Loaded ${existingIds.size} existing catalog IDs for deduplication`);

  // Fetch from all sources in parallel
  const [apisGuru, activepieces, n8n] = await Promise.all([
    fetchApisGuruCatalog(),
    fetchActivepiecesCatalog(),
    fetchN8nCatalog(),
  ]);

  // Merge and deduplicate
  const allEntries = [...apisGuru, ...activepieces, ...n8n];
  const deduplicated: ExternalCatalogEntry[] = [];
  const seenIds = new Set<string>();

  for (const entry of allEntries) {
    if (existingIds.has(entry.id) || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    deduplicated.push(entry);
  }

  // Sort by category, then name
  deduplicated.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  // Write the external catalog
  const outputPath = path.resolve(__dirname, '../src/core/mcp/ExternalCatalog.json');
  fs.writeFileSync(outputPath, JSON.stringify(deduplicated, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Sync] Complete!`);
  console.log(`  APIs.guru:     ${apisGuru.length} connectors`);
  console.log(`  Activepieces:  ${activepieces.length} connectors`);
  console.log(`  n8n:           ${n8n.length} connectors`);
  console.log(`  Deduplicated:  ${deduplicated.length} new connectors`);
  console.log(`  Total catalog: ${existingIds.size + deduplicated.length} connectors`);
  console.log(`  Written to:    ${outputPath}`);
  console.log(`  Time:          ${elapsed}s`);
}

main().catch((err) => {
  console.error('[Sync] Fatal error:', err);
  process.exit(1);
});
