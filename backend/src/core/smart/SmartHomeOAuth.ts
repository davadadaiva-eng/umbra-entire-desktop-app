/**
 * SmartHomeOAuth — OAuth 2.0 "authorization code" support for the CLOUD smart
 * home platforms, layered on the existing `OAuthConnector` used by MCP
 * connectors.
 *
 * Only platforms whose vendor actually offers a third-party OAuth app get an
 * entry here. The self-hosted platforms (Home Assistant, Hubitat, openHAB) and
 * the local bridges (HomeKit via homebridge, Alexa via alexa-remote-control,
 * Google via ghome) deliberately stay on pasted tokens: in those ecosystems a
 * long-lived token *is* the intended mechanism, there is no OAuth to use.
 *
 * Deliberately free of adapter imports so `SmartHomeAdapters` can depend on it
 * without a cycle.
 */

import type { OAuthClient, OAuthTokenSet } from '../mcp/OAuthConnector';

/** A cloud platform that supports "Sign in with …" instead of pasting a token. */
export interface SmartHomeOAuthProvider {
  /** Human label for the connect button. */
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Vendor requires the client_secret at the token endpoint (confidential client). */
  includeSecret?: boolean;
  /** Extra authorize-URL params, e.g. Google's offline access. */
  extraAuthParams?: Record<string, string>;
  /** Env prefix for the client id/secret, e.g. `UMBRA_SMARTTHINGS_CLIENT_ID`. */
  envPrefix: string;
  /**
   * Set when the platform can ONLY be reached over OAuth — a user who has not
   * registered an app cannot connect at all.
   */
  requiresClientApp?: boolean;
}

/**
 * Cloud platforms with a real public OAuth app registration.
 *
 * - SmartThings is a *confidential* client: you must register an app in the
 *   SmartThings developer workspace and hold both an id and a secret. There is
 *   no "paste a PAT and call it OAuth" shortcut.
 * - Google's scopes are the Smart Device Management ones, consumed by
 *   `GoogleSdmAdapter` (platform key `googlehome`, registry key `google`).
 *   SDM reaches only Google's own hardware (thermostats, cameras, doorbells,
 *   displays) and has no personal access token, so OAuth is the sole way in.
 */
export const SMART_HOME_OAUTH: Record<string, SmartHomeOAuthProvider> = {
  smartthings: {
    name: 'Samsung SmartThings',
    authorizeUrl: 'https://account.smartthings.com/oauth/authorize',
    tokenUrl: 'https://api.smartthings.com/v1/oauth/token',
    scopes: ['r:devices:*', 'w:devices:*', 'r:locations:*', 'w:locations:*'],
    includeSecret: true,
    envPrefix: 'UMBRA_SMARTTHINGS',
    requiresClientApp: true,
  },
  google: {
    name: 'Google Home',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/sdm.devices',
      'https://www.googleapis.com/auth/sdm.devices.commands',
      'https://www.googleapis.com/auth/sdm.devices.traits',
      // Structures + rooms drive the room grouping in the UI.
      'https://www.googleapis.com/auth/sdm.structures',
      'https://www.googleapis.com/auth/sdm.structures.commands',
    ],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    envPrefix: 'UMBRA_GOOGLE',
    requiresClientApp: true,
  },
};

/**
 * Build the OAuth client from env. Returns a clear, actionable error rather
 * than letting the flow start and fail at the vendor.
 */
export function oauthClientFor(platformKey: string, env: NodeJS.ProcessEnv = process.env): OAuthClient {
  const provider = SMART_HOME_OAUTH[platformKey];
  if (!provider) throw new Error(`"${platformKey}" does not support OAuth sign-in`);
  const clientId = (env[`${provider.envPrefix}_CLIENT_ID`] || '').trim();
  if (!clientId) {
    throw new Error(
      `No OAuth app registered for ${provider.name}. Create an app in the ` +
        `${provider.name} developer console, then set ${provider.envPrefix}_CLIENT_ID` +
        (provider.includeSecret ? ` and ${provider.envPrefix}_CLIENT_SECRET in backend/.env.` : '.'),
    );
  }
  return {
    clientId,
    // Public clients (PKCE) can omit the secret; confidential ones can't.
    clientSecret: provider.includeSecret
      ? (env[`${provider.envPrefix}_CLIENT_SECRET`] || '').trim() || undefined
      : undefined,
    authorizeUrl: provider.authorizeUrl,
    tokenUrl: provider.tokenUrl,
    scopes: provider.scopes,
  };
}

/** True when this platform has an OAuth app configured and can show a sign-in button. */
export function isOAuthConfigured(platformKey: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = SMART_HOME_OAUTH[platformKey];
  if (!provider) return false;
  if (!(env[`${provider.envPrefix}_CLIENT_ID`] || '').trim()) return false;
  if (provider.includeSecret && !(env[`${provider.envPrefix}_CLIENT_SECRET`] || '').trim()) return false;
  return true;
}

// ── Token-set persistence ──────────────────────────────────────────────────

/**
 * The vault stores one secret string per service, so the whole token set is
 * serialized as JSON under a `:oauth` suffix on the platform's vault key.
 * Keeping it separate from the pasted-token entry means a user can still fall
 * back to a PAT without clobbering their linked account.
 */
export function oauthVaultKey(platformKey: string): string {
  return `${platformKey}:oauth`;
}

export function encodeTokenSet(tokens: OAuthTokenSet): string {
  return JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType,
  });
}

export function decodeTokenSet(raw: string | undefined | null): OAuthTokenSet | undefined {
  if (!raw) return undefined;
  try {
    const json = JSON.parse(raw) as Partial<OAuthTokenSet>;
    if (!json.accessToken) return undefined;
    return {
      accessToken: String(json.accessToken),
      refreshToken: json.refreshToken ? String(json.refreshToken) : undefined,
      // 0 means "expiry unknown" — we then rely on the 401 refresh path
      // rather than refreshing on a guess.
      expiresAt: json.expiresAt ? Number(json.expiresAt) : 0,
      tokenType: json.tokenType ? String(json.tokenType) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Refresh a little early so a token can't expire mid-request. */
export const REFRESH_SKEW_MS = 60_000;

/** Does this token set need refreshing before the next call? */
export function needsRefresh(tokens: OAuthTokenSet | undefined, now: number = Date.now()): boolean {
  if (!tokens) return false;
  if (!tokens.refreshToken) return false;
  if (!tokens.expiresAt) return false;
  return tokens.expiresAt - now < REFRESH_SKEW_MS;
}
