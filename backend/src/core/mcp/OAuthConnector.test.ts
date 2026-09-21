import { OAuthConnector } from './OAuthConnector';

function makeConnector(tokenPayload: Record<string, unknown> = {}) {
  let captured: { url: string; body: string } | null = null;
  const connector = new OAuthConnector((async (url: any, init: any) => {
    captured = { url: String(url), body: String(init?.body ?? '') };
    return new Response(JSON.stringify(tokenPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any);
  return { connector, getCaptured: () => captured };
}

const REDIRECT = 'http://127.0.0.1:8787/api/mcp/oauth/callback';

describe('OAuthConnector', () => {
  describe('PKCE helpers', () => {
    it('generates a verifier within RFC 7636 length bounds', () => {
      const c = new OAuthConnector();
      const v = c.generateVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
    });

    it('produces a base64url S256 challenge deterministically', () => {
      const c = new OAuthConnector();
      expect(c.codeChallenge('verifier')).toBe(c.codeChallenge('verifier'));
      expect(c.codeChallenge('verifier')).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('resolve', () => {
    it('maps credential keys to provider endpoints + scopes', () => {
      const c = new OAuthConnector();
      const gmail = c.resolve('gmail', { clientId: 'cid' });
      expect(gmail.provider.tokenUrl).toContain('oauth2.googleapis.com');
      expect(gmail.provider.scopes).toContain('https://www.googleapis.com/auth/gmail.modify');

      const ms = c.resolve('microsoft-365', { clientId: 'cid' });
      expect(ms.provider.tokenUrl).toContain('microsoftonline.com');
      expect(ms.provider.scopes).toContain('Mail.Read');
    });

    it('requires clientId', () => {
      const c = new OAuthConnector();
      expect(() => c.resolve('gmail', { clientId: '' })).toThrow('clientId is required');
    });

    it('requires explicit endpoints for unknown providers', () => {
      const c = new OAuthConnector();
      expect(() => c.resolve('unknown-service', { clientId: 'cid' })).toThrow('No OAuth endpoints configured');
      const resolved = c.resolve('unknown-service', {
        clientId: 'cid',
        authorizeUrl: 'https://x/authorize',
        tokenUrl: 'https://x/token',
      });
      expect(resolved.provider.authorizeUrl).toBe('https://x/authorize');
    });
  });

  describe('begin', () => {
    it('builds a PKCE authorize URL with state and scopes', () => {
      const c = new OAuthConnector();
      const { authorizeUrl, state } = c.begin('gmail', { clientId: 'cid' }, REDIRECT);
      const u = new URL(authorizeUrl);
      expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(u.searchParams.get('response_type')).toBe('code');
      expect(u.searchParams.get('client_id')).toBe('cid');
      expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(u.searchParams.get('state')).toBe(state);
      expect(u.searchParams.get('scope')).toContain('gmail.modify');
    });

    it('adds offline-access params for Google refresh tokens', () => {
      const c = new OAuthConnector();
      const { authorizeUrl } = c.begin('gmail', { clientId: 'cid' }, REDIRECT);
      const u = new URL(authorizeUrl);
      expect(u.searchParams.get('access_type')).toBe('offline');
      expect(u.searchParams.get('prompt')).toBe('consent');
    });
  });

  describe('complete', () => {
    it('exchanges the code with PKCE and returns the bound key', async () => {
      const { connector, getCaptured } = makeConnector({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: '3600',
        token_type: 'Bearer',
      });
      const { state } = connector.begin('gmail', { clientId: 'cid' }, REDIRECT);
      const { key, tokens } = await connector.complete('the-code', state);

      expect(key).toBe('gmail');
      expect(tokens.accessToken).toBe('at-1');
      expect(tokens.refreshToken).toBe('rt-1');
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());

      const body = getCaptured()!.body;
      expect(getCaptured()!.url).toBe('https://oauth2.googleapis.com/token');
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=the-code');
      expect(body).toContain('redirect_uri=' + encodeURIComponent(REDIRECT));
      expect(body).toContain('code_verifier=');
    });

    it('includes the client secret for providers that require it', async () => {
      const { connector, getCaptured } = makeConnector({ access_token: 'at-1' });
      const { state } = connector.begin('github', { clientId: 'cid', clientSecret: 'sec' }, REDIRECT);
      await connector.complete('code', state);
      expect(getCaptured()!.body).toContain('client_secret=sec');
    });

    it('rejects an unknown or reused state', async () => {
      const { connector } = makeConnector({ access_token: 'at-1' });
      const { state } = connector.begin('gmail', { clientId: 'cid' }, REDIRECT);
      await connector.complete('code', state);
      await expect(connector.complete('code', state)).rejects.toThrow('Unknown or expired OAuth state');
      await expect(connector.complete('code', 'bogus')).rejects.toThrow('Unknown or expired OAuth state');
    });

    it('surfaces provider token errors', async () => {
      const connector = new OAuthConnector((async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as any);
      const { state } = connector.begin('gmail', { clientId: 'cid' }, REDIRECT);
      await expect(connector.complete('bad', state)).rejects.toThrow('invalid_grant');
    });
  });

  describe('refresh', () => {
    it('posts grant_type=refresh_token with the stored token', async () => {
      const { connector, getCaptured } = makeConnector({ access_token: 'at-2', expires_in: '3600' });
      const resolved = connector.resolve('gmail', { clientId: 'cid' });
      const tokens = await connector.refresh(resolved.client, resolved.provider, 'rt-1');
      expect(tokens.accessToken).toBe('at-2');
      expect(getCaptured()!.body).toContain('grant_type=refresh_token');
      expect(getCaptured()!.body).toContain('refresh_token=rt-1');
    });
  });
});
