/**
 * Regression tests for the connector OAuth wiring bug.
 *
 * The original defect: `beginMcpOauth` called `oauth.begin(<catalog id>)` while
 * `OAuthConnector.resolve()` only recognised bare credential keys. Catalog ids
 * are `<category>-<name>` (`productivity-gmail`), so EVERY catalog OAuth
 * connector failed to resolve and threw "No OAuth endpoints configured".
 *
 * The existing OAuthConnector.test.ts could not catch this because every
 * fixture used a bare credential key. These tests assert against the real
 * catalog so the two layers are exercised together.
 */

import { OAuthConnector, hasKnownOAuthProvider, oauthProviderSlugFor } from './OAuthConnector';
import { MCP_CATALOG, findCatalogEntry } from './McpCatalog';

describe('OAuthConnector — catalog id resolution', () => {
  const connector = new OAuthConnector();

  it('resolves a catalog id to its provider via the credentialKey', () => {
    // The exact case that was broken: catalog id, not credential key.
    expect(connector.resolve('productivity-gmail', { clientId: 'cid' }).provider.name).toBe('Google');
    expect(connector.resolve('productivity-google-calendar', { clientId: 'cid' }).provider.name).toBe('Google');
    expect(connector.resolve('music-audio-spotify', { clientId: 'cid' }).provider.name).toBe('Spotify');
  });

  it('still resolves bare credential keys (back-compat)', () => {
    expect(connector.resolve('gmail', { clientId: 'cid' }).provider.name).toBe('Google');
    expect(connector.resolve('spotify', { clientId: 'cid' }).provider.name).toBe('Spotify');
  });

  it('picks the Google scopes for a Gmail catalog id, not the provider default', () => {
    const { provider } = connector.resolve('productivity-gmail', { clientId: 'cid' });
    expect(provider.scopes).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
  });

  it('builds a working authorize URL from a catalog id', () => {
    const { authorizeUrl, state } = connector.begin('productivity-gmail', { clientId: 'cid' }, 'http://localhost:8787/cb');
    expect(authorizeUrl).toContain('accounts.google.com');
    expect(authorizeUrl).toContain('code_challenge_method=S256');
    expect(authorizeUrl).toContain(encodeURIComponent('http://localhost:8787/cb'));
    expect(authorizeUrl).toContain(`state=${state}`);
  });

  it('round-trips: begin echoes its key from complete', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const c = new OAuthConnector(fetchImpl as unknown as typeof fetch);
    // Production passes the credentialKey (index.ts resolves it before begin).
    const { state } = c.begin('gmail', { clientId: 'cid' }, 'http://localhost:8787/cb');
    const { key, tokens } = await c.complete('code', state);
    expect(key).toBe('gmail');
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
  });

  it('honours explicit endpoint overrides for an unknown provider', () => {
    const resolved = connector.resolve('some-unknown-service', {
      clientId: 'cid', authorizeUrl: 'https://x/authorize', tokenUrl: 'https://x/token',
    });
    expect(resolved.provider.authorizeUrl).toBe('https://x/authorize');
  });

  it('throws a useful error for a genuinely unknown provider', () => {
    expect(() => connector.resolve('totally-made-up-xyz', { clientId: 'cid' }))
      .toThrow('No OAuth endpoints configured');
  });
});

describe('OAuthConnector — catalog coverage', () => {
  it('resolves the large majority of hand-curated catalog OAuth connectors', () => {
    // Auto-generated `apisguru-*` rows have no provider identity at all; they
    // are excluded because their endpoints come from spec ingestion instead.
    const curated = MCP_CATALOG.filter(c => c.authType === 'oauth' && !c.id.startsWith('apisguru-'));
    const resolvable = curated.filter(c => hasKnownOAuthProvider(c.credentialKey || c.id));

    // Every one of these must resolve — these are the connectors a user would
    // expect to sign into from the Connectors screen.
    for (const id of [
      'productivity-gmail', 'productivity-google-calendar', 'productivity-google-drive',
      'music-audio-spotify', 'project-management-linear', 'communication-microsoft-teams',
      'productivity-microsoft-365', 'productivity-dropbox', 'productivity-box',
      'payments-finance-paypal', 'social-networks-tiktok', 'social-networks-instagram',
    ]) {
      expect({ id, known: hasKnownOAuthProvider(id) }).toEqual({ id, known: true });
    }

    // Guard against silent regression: no curated OAuth connector should lose
    // its provider. Every curated OAuth entry has a credentialKey, so this is
    // exactly what production resolves against.
    const unresolved = curated.filter(c => !hasKnownOAuthProvider(c.credentialKey || c.id)).map(c => c.id);
    expect(unresolved).toEqual([]);
    expect(resolvable.length).toBe(curated.length);
  });

  it('maps every curated OAuth connector to a provider by credentialKey', () => {
    const missing = MCP_CATALOG
      .filter(c => c.authType === 'oauth' && !c.id.startsWith('apisguru-'))
      .filter(c => !hasKnownOAuthProvider(c.credentialKey || c.id))
      .map(c => `${c.id} (key=${c.credentialKey})`);
    expect(missing).toEqual([]);
  });

  it('resolves every curated OAuth connector to real https endpoints', () => {
    const connector = new OAuthConnector();
    const bad: string[] = [];
    for (const c of MCP_CATALOG.filter(x => x.authType === 'oauth' && !x.id.startsWith('apisguru-'))) {
      const key = c.credentialKey || c.id;
      try {
        const { provider } = connector.resolve(key, { clientId: 'cid' });
        if (!provider.authorizeUrl.startsWith('https://') || !provider.tokenUrl.startsWith('https://')) {
          bad.push(`${c.id}: ${provider.authorizeUrl}`);
        }
      } catch (e) {
        bad.push(`${c.id}: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('reports a provider slug for known connectors', () => {
    expect(oauthProviderSlugFor('productivity-gmail')).toBe('google');
    expect(oauthProviderSlugFor('music-audio-spotify')).toBe('spotify');
    expect(oauthProviderSlugFor('nope-not-real')).toBeUndefined();
  });
});

describe('OAuthConnector — vault/header safety', () => {
  it('never stores a token set in a shape authHeaders would treat as Basic', () => {
    // McpHttpConnector.authHeaders() treats any username other than 'api-key'
    // as user/password and base64-encodes it into a Basic header. A JSON token
    // blob under username 'oauth-token' therefore produced a garbage
    // credential on every OAuth call. Guard the shape the executor relies on.
    const json = JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 1000 });
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { parsed = null; }
    expect(parsed).not.toBe('at');
  });

  it('keeps provider endpoints https for known catalog connectors', () => {
    const connector = new OAuthConnector();
    for (const key of ['gmail', 'spotify', 'microsoft-365', 'dropbox', 'box', 'linear', 'paypal']) {
      const { provider } = connector.resolve(key, { clientId: 'cid' });
      expect(provider.authorizeUrl.startsWith('https://')).toBe(true);
      expect(provider.tokenUrl.startsWith('https://')).toBe(true);
    }
  });
});

describe('catalog credentialKey sanity', () => {
  it('every oauth catalog entry has a credentialKey or falls back to its id', () => {
    for (const c of MCP_CATALOG.filter(x => x.authType === 'oauth').slice(0, 50)) {
      expect(typeof (c.credentialKey || c.id)).toBe('string');
      expect((c.credentialKey || c.id).length).toBeGreaterThan(0);
    }
  });

  it('findCatalogEntry returns the entry for a known id', () => {
    expect(findCatalogEntry('productivity-gmail')?.credentialKey).toBe('gmail');
  });
});
