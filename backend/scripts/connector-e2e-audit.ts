/**
 * connector-e2e-audit — the definitive "what actually works?" report.
 *
 * Unlike connector-auth-audit (which measures provider resolution), this
 * checks every precondition of a real tool call, so the answer reflects what a
 * user can actually do rather than what merely parses.
 *
 * A curated connector is END-TO-END only if all of these hold:
 *   1. it has >= 1 tool definition
 *   2. the tool has a base_url (so the request can be routed)
 *   3. auth_type 'none', OR it has a credential_service (lookup key)
 *   4. if oauth, the provider resolves AND we know the OAuth app endpoints
 *
 * Usage: npm run audit:e2e
 */

import { CURATED_TOOLS, curatedConnectorForCatalogId } from '../src/core/mcp/curatedTools';
import { OAuthConnector, hasKnownOAuthProvider } from '../src/core/mcp/OAuthConnector';
import { findCatalogEntry, MCP_CATALOG } from '../src/core/mcp/McpCatalog';

const oauth = new OAuthConnector();

interface Row {
  name: string;
  connectorId: string;
  tools: number;
  authType: string;
  credentialService: string;
  baseUrl: boolean;
  provider: string;
  endToEnd: boolean;
  blockers: string[];
}

const grouped = new Map<string, typeof CURATED_TOOLS>();
for (const t of CURATED_TOOLS) {
  grouped.set(t.connector_id, [...(grouped.get(t.connector_id) || []), t]);
}

const rows: Row[] = [];

for (const [cid, tools] of grouped) {
  const def = tools[0];
  const curated = curatedConnectorForCatalogId(cid);
  const catalogId = cid.replace(/^curated-/, '');
  const entry = findCatalogEntry(catalogId) ?? findCatalogEntry(def.credential_service ?? '');
  const key = entry?.credentialKey ?? catalogId;

  const blockers: string[] = [];
  if (tools.length === 0) blockers.push('no tools');
  if (!def.base_url) blockers.push('no base_url');
  if (def.auth_type !== 'none' && !def.credential_service) blockers.push('no credential_service');

  let provider = '—';
  if (def.auth_type === 'oauth') {
    if (!hasKnownOAuthProvider(key)) {
      blockers.push('no OAuth provider');
    } else {
      provider = oauth.resolve(key, { clientId: 'audit' }).provider.name;
    }
  } else {
    provider = 'API key';
  }

  rows.push({
    name: curated?.name ?? cid,
    connectorId: cid,
    tools: tools.length,
    authType: def.auth_type,
    credentialService: def.credential_service ?? '—',
    baseUrl: Boolean(def.base_url),
    provider,
    endToEnd: blockers.length === 0,
    blockers,
  });
}

rows.sort((a, b) => Number(b.endToEnd) - Number(a.endToEnd) || a.name.localeCompare(b.name));

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const totalTools = rows.reduce((a, r) => a + r.tools, 0);
const ok = rows.filter(r => r.endToEnd);

console.log('══ Curated connectors that work end to end ══\n');
for (const r of ok) {
  console.log(
    `${pad(r.name, 17)}${pad(r.tools + ' tools', 10)}${pad(r.authType, 8)}` +
    `${pad(r.provider, 12)}cred=${pad(r.credentialService, 11)}`,
  );
}
console.log(`\n${ok.length} of ${rows.length} curated connectors are end-to-end (${totalTools} tools total).`);

const broken = rows.filter(r => !r.endToEnd);
if (broken.length) {
  console.log('\n══ Blocked ══');
  for (const r of broken) console.log(`  ${r.name}: ${r.blockers.join(', ')}`);
}

console.log('\n══ Everything else in the catalog ══');
const withTools = rows.length;
const catalogWithBase = MCP_CATALOG.filter(c => c.baseUrl && c.baseUrl.trim()).length;
console.log(`  Catalog entries:                 ${MCP_CATALOG.length}`);
console.log(`  With curated callable tools:     ${withTools}`);
console.log(`  With a base_url but NO tools:    ${catalogWithBase - withTools}`);
console.log(`  With neither (name-only rows):   ${MCP_CATALOG.length - catalogWithBase}`);
console.log('\n  Name-only rows can become usable via ensureConnectorTools() once their');
console.log('  OpenAPI spec is synced (specUrl) — see scripts/sync-connectors.ts.');
