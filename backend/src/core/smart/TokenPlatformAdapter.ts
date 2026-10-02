/**
 * TokenPlatformAdapter — the shared base for every credential-backed smart
 * home platform adapter.
 *
 * Lives in its own module (rather than beside the concrete adapters) so that
 * individual adapters can subclass it without importing the aggregate file:
 * GoogleSdmAdapter extends this, and SmartHomeAdapters imports GoogleSdmAdapter,
 * so keeping both in one file would create an import cycle where
 * `class X extends TokenPlatformAdapter` resolves to `undefined`.
 *
 * Owns the vault-backed credential store, the optional OAuth session
 * (sign-in, refresh, 401-replay) and the `HttpBridge.request` network seam
 * that every concrete adapter funnels through.
 */

import { HttpBridge } from '../agent/HttpBridge';
import { getLogger } from '../Logger';
import { OAuthConnector, type OAuthTokenSet } from '../mcp/OAuthConnector';
import type { SwitchCommand } from './SmartThingsService';
import type { SmartHomePlatform, SmartHomeDeviceV2 } from './SmartHomePlatform';
import {
  decodeTokenSet,
  encodeTokenSet,
  isOAuthConfigured,
  needsRefresh,
  oauthClientFor,
  oauthVaultKey,
  type SmartHomeOAuthProvider,
} from './SmartHomeOAuth';

/** Shared token-adapter base — persisted via the Umbra credential vault. */
export abstract class TokenPlatformAdapter implements SmartHomePlatform {
  abstract readonly key: string;
  abstract readonly label: string;
  abstract readonly help: string;
  readonly credentialsUrl?: string;
  lastError?: string;

  protected token = '';
  protected baseUrl = '';
  /** Present only on cloud platforms whose vendor offers a real OAuth app. */
  protected oauth?: SmartHomeOAuthProvider;
  /**
   * Key into the SMART_HOME_OAUTH registry. Usually the same as the platform
   * key, but not always — Google's registry entry is `google` while the
   * platform is `googlehome`. Vault keys always use the platform key.
   */
  protected oauthKey?: string;

  /** Registry key for this platform's OAuth provider. */
  private get oauthRegistryKey(): string {
    return this.oauthKey || this.key;
  }
  private oauthFlows = new OAuthConnector();
  private tokenSetCache?: OAuthTokenSet;
  private tokenSetLoaded = false;

  constructor(
    protected vault?: { find(s: string): { secret: string } | undefined; set(e: { service: string; username: string; secret: string }, id?: string): unknown; remove(s: string): boolean; isUnlocked: boolean },
    protected vaultKey?: string,
  ) {
    this.token = this.loadToken();
  }

  /**
   * The stored OAuth session, read from the vault on first use.
   *
   * Deliberately lazy: `oauth` is declared as a class field on the *subclass*,
   * so it is still undefined while this base constructor runs and an eager
   * load here would silently skip every persisted session.
   */
  protected tokens(): OAuthTokenSet | undefined {
    if (!this.tokenSetLoaded) {
      this.tokenSetCache = this.oauth ? this.loadTokenSet() : undefined;
      this.tokenSetLoaded = true;
    }
    return this.tokenSetCache;
  }

  /** Replace the in-memory session (also marks the cache warm). */
  protected setTokens(tokens: OAuthTokenSet | undefined): void {
    this.tokenSetCache = tokens;
    this.tokenSetLoaded = true;
  }

  protected loadToken(): string {
    try {
      return this.vault?.find(this.vaultKey || this.key)?.secret?.trim() || '';
    } catch {
      return '';
    }
  }

  /** OAuth access/refresh pair, stored separately from any pasted PAT. */
  private loadTokenSet(): OAuthTokenSet | undefined {
    try {
      return decodeTokenSet(this.vault?.find(oauthVaultKey(this.key))?.secret);
    } catch {
      return undefined;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.token || this.tokens()?.accessToken);
  }

  /** Can this platform show a "Sign in with …" button right now? */
  supportsOAuth(): boolean {
    return Boolean(this.oauth) && isOAuthConfigured(this.oauthRegistryKey);
  }

  getOAuthProvider(): SmartHomeOAuthProvider | undefined {
    return this.oauth;
  }

  // ── OAuth flow (cloud platforms only) ───────────────────────

  /** Step 1: build the vendor consent URL the desktop opens in a browser. */
  beginOAuth(redirectUri: string): { authorizeUrl: string; state: string } {
    if (!this.oauth) throw new Error(`${this.label} does not support OAuth sign-in`);
    return this.oauthFlows.begin(this.oauthRegistryKey, oauthClientFor(this.oauthRegistryKey), redirectUri);
  }

  /** Step 2: exchange the callback code, validate, and persist. */
  async completeOAuth(code: string, state: string): Promise<{ ok: boolean; deviceCount: number; tokenMasked: string }> {
    if (!this.oauth) throw new Error(`${this.label} does not support OAuth sign-in`);
    const client = oauthClientFor(this.oauthRegistryKey);
    const { tokens } = await this.oauthFlows.complete(code, state);
    // The connector is stateless across flows; the client is only needed for
    // the exchange itself, which `complete` already did.
    void client;

    const prev = this.tokens();
    this.setTokens(tokens);
    try {
      const devices = await this.getDevices({ withStates: false });
      this.persistTokenSet(tokens);
      this.lastError = undefined;
      return { ok: true, deviceCount: devices.length, tokenMasked: this.getMaskedToken() };
    } catch (e) {
      this.setTokens(prev);
      throw e;
    }
  }

  private persistTokenSet(tokens: OAuthTokenSet): void {
    try {
      if (this.vault?.isUnlocked) {
        this.vault.set({ service: oauthVaultKey(this.key), username: 'oauth', secret: encodeTokenSet(tokens) });
      }
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, 'SmartHome: failed to persist OAuth token set');
    }
  }

  /** Exchange the refresh token for a new access token before it expires. */
  protected async refreshOAuth(): Promise<boolean> {
    const current = this.tokens();
    if (!this.oauth || !current?.refreshToken) return false;
    try {
      const client = oauthClientFor(this.oauthRegistryKey);
      const provider = {
        name: this.oauth.name,
        authorizeUrl: this.oauth.authorizeUrl,
        tokenUrl: this.oauth.tokenUrl,
        scopes: this.oauth.scopes,
        includeSecret: this.oauth.includeSecret,
      };
      const next = await this.oauthFlows.refresh(client, provider, current.refreshToken!);
      // Vendors that rotate refresh tokens omit the old one; never lose ours.
      const merged: OAuthTokenSet = {
        ...next,
        refreshToken: next.refreshToken || current.refreshToken,
      };
      this.setTokens(merged);
      this.persistTokenSet(merged);
      return true;
    } catch (e) {
      this.lastError = `Session expired — sign in again at ${this.credentialsUrl || 'the vendor console'}`;
      getLogger().warn({ platform: this.key, err: (e as Error).message }, 'SmartHome: OAuth refresh failed');
      return false;
    }
  }

  /** The bearer value to use for the next request, refreshing if it is stale. */
  protected async authHeader(): Promise<string> {
    const current = this.tokens();
    if (current?.accessToken) {
      if (needsRefresh(current)) await this.refreshOAuth();
      if (this.tokens()?.accessToken) return `Bearer ${this.tokens()!.accessToken}`;
    }
    return this.token ? `Bearer ${this.token}` : '';
  }

  getMaskedToken(): string {
    // Prefer the OAuth session so the UI reflects what requests actually use.
    const shown = this.tokens()?.accessToken || this.token;
    if (!shown) return '';
    return shown.length <= 8 ? '••••' : `${shown.slice(0, 4)}••••${shown.slice(-4)}`;
  }

  async setToken(token: string, url?: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }> {
    const t = token.trim();
    if (!t) throw new Error('token is required');
    if (url?.trim()) this.baseUrl = url.trim().replace(/\/+$/, '');
    const prev = this.token;
    const prevUrl = this.baseUrl;
    this.token = t;
    try {
      const devices = await this.getDevices({ withStates: false });
      if (this.vault?.isUnlocked) {
        this.vault.set({ service: this.vaultKey || this.key, username: 'pat', secret: t });
      }
      this.lastError = undefined;
      return { ok: true, deviceCount: devices.length, tokenMasked: this.getMaskedToken() };
    } catch (e) {
      this.token = prev;
      this.baseUrl = prevUrl;
      throw e;
    }
  }

  async clearToken(): Promise<void> {
    try {
      if (this.vault?.isUnlocked) {
        this.vault.remove(this.vaultKey || this.key);
        this.vault.remove(oauthVaultKey(this.key));
      }
    } catch { /* ignore */ }
    this.token = '';
    this.setTokens(undefined);
  }

  /** curl-backed HTTP via HttpBridge (bypasses Node v24 TLS quirks). */
  protected async request<T>(method: 'GET' | 'POST' | 'PUT', url: string, opts?: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number }): Promise<T> {
    let res;
    const send = (headers: Record<string, string>) => HttpBridge.request({
      url,
      method,
      headers,
      body: opts?.body,
      timeoutMs: opts?.timeoutMs ?? 15000,
    });
    try {
      res = await send(opts?.headers || {});
    } catch (e) {
      const host = new URL(url).host;
      throw new Error(`Could not reach ${host} — check the server URL and that the hub is online (${String((e as Error).message || '').split('\n')[0].slice(0, 140)})`);
    }
    // A 401 on an OAuth session usually means the token expired early (clock
    // skew, revocation, a vendor cutting the TTL). Refresh once and replay the
    // call once rather than sticking the platform in a permanent error state.
    if (res.status === 401 && this.tokens()?.refreshToken) {
      const refreshed = await this.refreshOAuth();
      if (refreshed) {
        const headers = { ...(opts?.headers || {}), Authorization: `Bearer ${this.tokens()!.accessToken}` };
        try {
          res = await send(headers);
        } catch {
          throw new Error(`Could not reach ${new URL(url).host} — check the server URL and that the hub is online`);
        }
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(this.humanizeHttpError(res.status, res.text || `HTTP ${res.status}`));
    }
    try {
      return (res.text ? JSON.parse(res.text) : {}) as T;
    } catch {
      return res.text as unknown as T;
    }
  }

  protected humanizeHttpError(status: number, raw: string): string {
    if (status === 401) return `Token rejected (401) — regenerate at ${this.credentialsUrl || 'the vendor console'}`;
    if (status === 403) return `Token missing scope/permission (403) — recreate with required scopes`;
    if (status === 404) return `Endpoint not found (404) — check the base URL`;
    return raw;
  }

  abstract getDevices(opts?: { withStates?: boolean }): Promise<SmartHomeDeviceV2[]>;
  abstract sendCommand(nativeId: string, command: SwitchCommand): Promise<void>;
}
