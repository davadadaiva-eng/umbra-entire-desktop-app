/**
 * OAuthConnector — generic OAuth 2.0 "authorization code + PKCE" flow used to
 * connect the catalog's `oauth` connectors (Gmail, Microsoft 365, Dropbox,
 * Notion, Slack, …). Zero dependencies: Node's global fetch + crypto.
 *
 * Security model:
 *   - PKCE (S256) so no client_secret is required for public clients — the
 *     same flow works on a desktop loopback or a cloud https origin.
 *   - A random `state` is bound to the pending flow and checked on the
 *     callback to defeat CSRF/login-forcing.
 *   - Pending flows are held in memory with a short TTL; tokens themselves
 *     are persisted in the CredentialVault by UmbraOS (not here).
 *
 * Provider resolution:
 *   1. A well-known provider table (Google, Microsoft, Dropbox, …) with
 *      stable endpoints + default scopes.
 *   2. A per-connector scope map (credentialKey → provider + scopes) so
 *      Gmail, Calendar, Drive, … request the right scopes.
 *   3. Everything else falls back to operator-supplied endpoints in
 *      `config.mcp.oauthClients[<credentialKey>]` — so any provider in the
 *      catalog can be connected once its client is registered.
 */

import * as crypto from 'crypto';
import { getLogger } from '../Logger';

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType?: string;
  scope?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

export interface BeginOAuthResult {
  authorizeUrl: string;
  state: string;
}

export interface OAuthProviderDef {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Static query params added to the authorize URL (e.g. Google's offline access). */
  extraAuthParams?: Record<string, string>;
  /** Providers whose token endpoint also needs the client_secret (GitHub, Slack…). */
  includeSecret?: boolean;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  key: string;
  state: string;
  verifier: string;
  redirectUri: string;
  client: OAuthClient;
  provider: OAuthProviderDef;
  createdAt: number;
}

/** Well-known providers with stable, publicly-documented endpoints. */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  google: {
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile'],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    name: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'User.Read'],
  },
  dropbox: {
    name: 'Dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: [],
  },
  github: {
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
    includeSecret: true,
  },
  linear: {
    name: 'Linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
  },
  notion: {
    name: 'Notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
  },
  slack: {
    name: 'Slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'chat:write'],
    includeSecret: true,
  },
  spotify: {
    name: 'Spotify',
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scopes: ['user-read-playback-state', 'playlist-read-private'],
  },
  figma: {
    name: 'Figma',
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://www.figma.com/api/oauth/token',
    scopes: ['files:read'],
  },
  box: {
    name: 'Box',
    authorizeUrl: 'https://account.box.com/api/oauth2/authorize',
    tokenUrl: 'https://api.box.com/oauth2/token',
    scopes: [],
  },
  reddit: {
    name: 'Reddit',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    scopes: ['read', 'identity'],
  },
  evernote: {
    name: 'Evernote',
    authorizeUrl: 'https://www.evernote.com/oauth',
    tokenUrl: 'https://www.evernote.com/oauth',
    scopes: ['basic'],
  },
  twitch: {
    name: 'Twitch',
    authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scopes: ['user:read:email'],
  },
};

/**
 * credentialKey → { provider, scopes }. Only the connectors whose scopes
 * differ from the provider default (or where the credentialKey ≠ provider
 * slug) need an entry; everything else resolves via `providerFor`.
 */
const CONNECTOR_OAUTH: Record<string, { provider: string; scopes: string[] }> = {
  // Google workspace (scoped per product)
  gmail: { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  'google-calendar': { provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar'] },
  'google-drive': { provider: 'google', scopes: ['https://www.googleapis.com/auth/drive'] },
  'google-docs': { provider: 'google', scopes: ['https://www.googleapis.com/auth/documents'] },
  'google-sheets': { provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
  bigquery: { provider: 'google', scopes: ['https://www.googleapis.com/auth/bigquery'] },
  gcp: { provider: 'google', scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
  ga4: { provider: 'google', scopes: ['https://www.googleapis.com/auth/analytics.readonly'] },
  'search-console': { provider: 'google', scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] },
  'google-fit': { provider: 'google', scopes: ['https://www.googleapis.com/auth/fitness.activity.read'] },
  blogger: { provider: 'google', scopes: ['https://www.googleapis.com/auth/blogger'] },
  'google-identity': { provider: 'google', scopes: ['openid', 'email', 'profile'] },
  // Microsoft / Azure AD
  'microsoft-365': { provider: 'microsoft', scopes: ['offline_access', 'User.Read', 'Mail.Read', 'Calendars.ReadWrite', 'Files.ReadWrite'] },
  onedrive: { provider: 'microsoft', scopes: ['offline_access', 'Files.ReadWrite'] },
  teams: { provider: 'microsoft', scopes: ['offline_access', 'User.Read', 'ChannelMessage.ReadWrite', 'Team.ReadBasic.All'] },
  'azure-ad': { provider: 'microsoft', scopes: ['offline_access', 'User.Read', 'Directory.Read.All'] },
  // Named providers whose slug differs from the credentialKey
  'notion-calendar': { provider: 'notion', scopes: [] },
};

/** Guess a provider slug from a connector credentialKey. */
function providerSlugFor(key: string): string | undefined {
  if (CONNECTOR_OAUTH[key]) return CONNECTOR_OAUTH[key].provider;
  if (OAUTH_PROVIDERS[key]) return key;
  return undefined;
}

export interface ResolvedOAuth {
  client: OAuthClient;
  provider: OAuthProviderDef;
}

export class OAuthConnector {
  private pending = new Map<string, PendingAuth>();
  private fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /**
   * Resolve a connector's OAuth endpoints + scopes from the operator's
   * client config. Known providers use their registry defaults; unknown ones
   * require `authorizeUrl`/`tokenUrl` in the client config.
   */
  resolve(key: string, client: OAuthClient): ResolvedOAuth {
    const slug = providerSlugFor(key);
    const base = slug ? OAUTH_PROVIDERS[slug] : undefined;

    if (!base && (!client.authorizeUrl || !client.tokenUrl)) {
      throw new Error(
        `No OAuth endpoints configured for "${key}" — add mcp.oauthClients["${key}"] with clientId + authorizeUrl + tokenUrl`,
      );
    }

    const provider: OAuthProviderDef = {
      name: base?.name ?? key,
      authorizeUrl: client.authorizeUrl || base!.authorizeUrl,
      tokenUrl: client.tokenUrl || base!.tokenUrl,
      scopes: client.scopes ?? (CONNECTOR_OAUTH[key]?.scopes ?? base?.scopes ?? []),
      extraAuthParams: base?.extraAuthParams,
      includeSecret: base?.includeSecret,
    };

    if (!client.clientId) {
      throw new Error(`OAuth clientId is required for "${key}" (register an app with the provider first)`);
    }

    return { client, provider };
  }

  /** Start the flow: build the authorize URL and remember the PKCE/state. */
  begin(key: string, client: OAuthClient, redirectUri: string): BeginOAuthResult {
    const { provider } = this.resolve(key, client);
    const verifier = this.generateVerifier();
    const state = crypto.randomBytes(16).toString('hex');
    const challenge = this.codeChallenge(verifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (provider.scopes.length) params.set('scope', provider.scopes.join(' '));
    for (const [k, v] of Object.entries(provider.extraAuthParams ?? {})) params.set(k, v);

    this.prune();
    this.pending.set(state, {
      key,
      state,
      verifier,
      redirectUri,
      client,
      provider,
      createdAt: Date.now(),
    });

    getLogger().info({ key, provider: provider.name }, 'OAuth flow started');
    return { authorizeUrl: `${provider.authorizeUrl}?${params.toString()}`, state };
  }

  /**
   * Exchange the authorization code for tokens (validates state first).
   * The callback only receives `code` + `state`, so the connector id is
   * recovered from the pending flow and returned alongside the tokens.
   */
  async complete(code: string, state: string): Promise<{ key: string; tokens: OAuthTokenSet }> {
    const pending = this.pending.get(state);
    if (!pending) throw new Error('Unknown or expired OAuth state — start the flow again');
    this.pending.delete(state);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.client.clientId,
      code_verifier: pending.verifier,
    });
    if (pending.client.clientSecret && pending.provider.includeSecret) {
      body.set('client_secret', pending.client.clientSecret);
    }

    const tokens = await this.exchange(pending.provider.tokenUrl, body);
    getLogger().info({ key: pending.key }, 'OAuth flow completed');
    return { key: pending.key, tokens };
  }

  /** Refresh an access token (no-op-safe when the provider gave no refresh token). */
  async refresh(client: OAuthClient, provider: OAuthProviderDef, refreshToken: string): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
    });
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
    return this.exchange(provider.tokenUrl, body);
  }

  // ── PKCE helpers ──────────────────────────────────────────

  generateVerifier(): string {
    // 48 bytes → 64 base64url chars, within RFC 7636's 43–128 range.
    return crypto.randomBytes(48).toString('base64url');
  }

  codeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  // ── internals ─────────────────────────────────────────────

  private async exchange(tokenUrl: string, body: URLSearchParams): Promise<OAuthTokenSet> {
    const res = await this.fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OAuth token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = this.parseTokenPayload(text);
    if (!json.access_token) {
      throw new Error('OAuth token response did not include an access_token');
    }
    return {
      accessToken: String(json.access_token),
      refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
      expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
      tokenType: json.token_type ? String(json.token_type) : undefined,
      scope: json.scope ? String(json.scope) : undefined,
    };
  }

  private parseTokenPayload(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text);
    } catch {
      // Some providers (GitHub) return form-encoded bodies unless asked.
      return Object.fromEntries(new URLSearchParams(text));
    }
  }

  private prune(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(state);
    }
  }
}
