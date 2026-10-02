/**
 * SmartHomeOAuth.test.ts — OAuth sign-in for the CLOUD smart home platforms.
 *
 * Covered here:
 *  - the provider registry: env-driven client construction and the actionable
 *    error a user gets before they have registered a vendor app
 *  - the vault token-set codec (JSON, rotated refresh tokens, unknown expiry)
 *  - refresh-scheduling skew
 *  - the adapter flow: begin -> complete (validate-before-persist) -> rollback
 *  - the request() 401 path: refresh once, replay once, then fail honestly
 *  - the catalog's authMode / oauthConfigured reporting
 */

import { HttpBridge } from '../agent/HttpBridge';
import { OAuthConnector } from '../mcp/OAuthConnector';
import { SmartThingsAdapter, SmartThingsPlatformWrapper, TuyaAdapter } from './SmartHomeAdapters';
import { SmartHomeHub } from './SmartHomePlatform';
import type { SmartThingsService } from './SmartThingsService';
import {
  REFRESH_SKEW_MS,
  decodeTokenSet,
  encodeTokenSet,
  isOAuthConfigured,
  needsRefresh,
  oauthClientFor,
  oauthVaultKey,
} from './SmartHomeOAuth';

interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** Same seam as SmartHomeAdapters.test.ts — HttpBridge.request is the only network path. */
function mockHttp(handler: (method: string, url: string) => { status: number; text?: string } | undefined): {
  calls: HttpCall[];
  restore(): void;
} {
  const calls: HttpCall[] = [];
  const spy = jest.spyOn(HttpBridge, 'request').mockImplementation(((opts: {
    url: string; method?: string; headers?: Record<string, string>;
  }) => {
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, url: opts.url, headers: opts.headers || {} });
    const res = handler(method, opts.url);
    if (!res) throw new Error(`mockHttp: no route for ${method} ${opts.url}`);
    return Promise.resolve({ status: res.status, data: null, text: res.text ?? '' });
  }) as typeof HttpBridge.request);
  return { calls, restore: () => spy.mockRestore() };
}

/** Minimal in-memory stand-in for the credential vault. */
function fakeVault(seed: Record<string, string> = {}) {
  const entries: Record<string, string> = { ...seed };
  const sets: string[] = [];
  const removes: string[] = [];
  return {
    entries,
    sets,
    removes,
    find: (s: string) => (entries[s] !== undefined ? { secret: entries[s] } : undefined),
    set: (e: { service: string; secret: string }) => {
      entries[e.service] = e.secret;
      sets.push(e.service);
      return true;
    },
    remove: (s: string) => {
      removes.push(s);
      return delete entries[s];
    },
    isUnlocked: true,
  };
}

const ST_ENV = {
  UMBRA_SMARTTHINGS_CLIENT_ID: 'st-client-id',
  UMBRA_SMARTTHINGS_CLIENT_SECRET: 'st-client-secret',
};
const GOOGLE_ENV = { UMBRA_GOOGLE_CLIENT_ID: 'goog-client-id' };

const ST_DEVICES = {
  items: [
    {
      deviceId: 'dev-1',
      label: 'Porch Light',
      manufacturerName: 'Aeotec',
      components: [{ id: 'main', capabilities: [{ id: 'switch' }] }],
    },
  ],
};

describe('SmartHomeOAuth: provider registry', () => {
  it('refuses an unknown platform with an explicit message', () => {
    expect(() => oauthClientFor('homeassistant', ST_ENV)).toThrow(/does not support OAuth sign-in/);
  });

  it('names the exact env vars to set when no vendor app is registered', () => {
    expect(() => oauthClientFor('smartthings', {})).toThrow(/UMBRA_SMARTTHINGS_CLIENT_ID/);
    expect(() => oauthClientFor('smartthings', {})).toThrow(/UMBRA_SMARTTHINGS_CLIENT_SECRET/);
    // Public-client platforms should not demand a secret they never use.
    expect(() => oauthClientFor('google', {})).toThrow(/UMBRA_GOOGLE_CLIENT_ID/);
    expect(() => oauthClientFor('google', {})).not.toThrow(/UMBRA_GOOGLE_CLIENT_SECRET/);
  });

  it('passes the client secret for confidential clients and omits it for public ones', () => {
    expect(oauthClientFor('smartthings', ST_ENV).clientSecret).toBe('st-client-secret');
    expect(oauthClientFor('google', GOOGLE_ENV).clientSecret).toBeUndefined();
  });

  it('carries the vendor endpoints and scopes onto the client', () => {
    const c = oauthClientFor('smartthings', ST_ENV);
    expect(c.clientId).toBe('st-client-id');
    expect(c.authorizeUrl).toContain('smartthings.com');
    expect(c.tokenUrl).toContain('smartthings.com');
    expect(c.scopes).toContain('w:devices:*');
  });

  it('requires the secret before SmartThings counts as configured, but not for Google', () => {
    expect(isOAuthConfigured('smartthings', {})).toBe(false);
    expect(isOAuthConfigured('smartthings', { UMBRA_SMARTTHINGS_CLIENT_ID: 'x' })).toBe(false);
    expect(isOAuthConfigured('smartthings', ST_ENV)).toBe(true);
    expect(isOAuthConfigured('google', GOOGLE_ENV)).toBe(true);
    expect(isOAuthConfigured('homeassistant', ST_ENV)).toBe(false);
  });
});

describe('SmartHomeOAuth: token-set codec', () => {
  it('round-trips a full token set', () => {
    const tokens = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 123, tokenType: 'bearer' };
    expect(decodeTokenSet(encodeTokenSet(tokens))).toEqual(tokens);
  });

  it('survives a rotated refresh token and a missing one', () => {
    expect(decodeTokenSet(encodeTokenSet({ accessToken: 'at', refreshToken: 'rt-2', expiresAt: 9 }))?.refreshToken)
      .toBe('rt-2');
    expect(decodeTokenSet(encodeTokenSet({ accessToken: 'at', expiresAt: 9 }))?.refreshToken).toBeUndefined();
  });

  it('treats an unknown expiry as 0 (rely on the 401 path, not a guess)', () => {
    expect(decodeTokenSet(JSON.stringify({ accessToken: 'at' }))?.expiresAt).toBe(0);
  });

  it('returns undefined for junk, empty and access-token-less payloads', () => {
    expect(decodeTokenSet(undefined)).toBeUndefined();
    expect(decodeTokenSet('')).toBeUndefined();
    expect(decodeTokenSet('not json')).toBeUndefined();
    expect(decodeTokenSet(JSON.stringify({ refreshToken: 'rt' }))).toBeUndefined();
  });

  it('namespaces the vault key so a PAT and a session can coexist', () => {
    expect(oauthVaultKey('smartthings')).toBe('smartthings:oauth');
  });
});

describe('SmartHomeOAuth: refresh scheduling', () => {
  const now = 1_000_000;

  it('refreshes inside the skew window but not before it', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 100 }, now)).toBe(true);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: now + REFRESH_SKEW_MS + 1 }, now)).toBe(false);
  });

  it('never refreshes without a refresh token, expiry, or token set', () => {
    expect(needsRefresh(undefined, now)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', expiresAt: now }, now)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, now)).toBe(false);
  });
});

describe('SmartThingsAdapter: OAuth flow', () => {
  const redirect = 'http://127.0.0.1:8787/api/smart/platforms/smartthings/oauth/callback';
  let http: ReturnType<typeof mockHttp>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env['UMBRA_SMARTTHINGS_CLIENT_ID'] = 'st-client-id';
    process.env['UMBRA_SMARTTHINGS_CLIENT_SECRET'] = 'st-client-secret';
  });
  afterEach(() => {
    http?.restore();
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it('begins a PKCE flow with the vendor authorize URL', () => {
    const a = new SmartThingsAdapter();
    const { authorizeUrl, state } = a.beginOAuth(redirect);
    expect(state).toHaveLength(32);
    expect(authorizeUrl).toContain('https://account.smartthings.com/oauth/authorize?');
    expect(authorizeUrl).toContain('code_challenge_method=S256');
    expect(authorizeUrl).toContain(encodeURIComponent(redirect));
    expect(a.supportsOAuth()).toBe(true);
  });

  it('refuses to begin without a registered vendor app', () => {
    delete process.env['UMBRA_SMARTTHINGS_CLIENT_ID'];
    const a = new SmartThingsAdapter();
    expect(a.supportsOAuth()).toBe(false);
    expect(() => a.beginOAuth(redirect)).toThrow(/UMBRA_SMARTTHINGS_CLIENT_ID/);
  });

  it('validates by listing devices, then persists the token set', async () => {
    http = mockHttp((_m, url) => (url.includes('/v1/devices') ? { status: 200, text: JSON.stringify(ST_DEVICES) } : undefined));
    jest.spyOn(OAuthConnector.prototype, 'begin').mockImplementation(function (this: OAuthConnector) {
      return { authorizeUrl: 'https://vendor.test/authorize?state=st', state: 'st' };
    });
    jest.spyOn(OAuthConnector.prototype, 'complete').mockResolvedValue({
      key: 'smartthings',
      tokens: { accessToken: 'access-abcdefgh', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 },
    });

    const vault = fakeVault();
    const a = new SmartThingsAdapter(vault as never);
    const res = await a.completeOAuth('code-1', 'st');

    expect(res.ok).toBe(true);
    expect(res.deviceCount).toBe(1);
    expect(vault.sets).toEqual([oauthVaultKey('smartthings')]);
    expect(decodeTokenSet(vault.entries[oauthVaultKey('smartthings')])?.refreshToken).toBe('refresh-1');
    expect(a.isConfigured()).toBe(true);
    expect(a.getMaskedToken()).toMatch(/^acce••••efgh$/);
  });

  it('does not persist a session whose validation call fails', async () => {
    http = mockHttp(() => ({ status: 403, text: 'Forbidden' }));
    jest.spyOn(OAuthConnector.prototype, 'complete').mockResolvedValue({
      key: 'smartthings',
      tokens: { accessToken: 'access-abcdefgh', refreshToken: 'refresh-1', expiresAt: 0 },
    });

    const vault = fakeVault();
    const a = new SmartThingsAdapter(vault as never);
    await expect(a.completeOAuth('code-1', 'st')).rejects.toThrow();
    expect(vault.sets).toEqual([]);
    expect(a.isConfigured()).toBe(false);
  });

  it('restores the previous session when a reconnect fails', async () => {
    const vault = fakeVault({
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'good-token', refreshToken: 'rt', expiresAt: 0 }),
    });
    const a = new SmartThingsAdapter(vault as never);
    expect(a.isConfigured()).toBe(true);

    http = mockHttp(() => ({ status: 500, text: 'boom' }));
    jest.spyOn(OAuthConnector.prototype, 'complete').mockResolvedValue({
      key: 'smartthings',
      tokens: { accessToken: 'bad-token', refreshToken: 'rt2', expiresAt: 0 },
    });
    await expect(a.completeOAuth('code-2', 'st')).rejects.toThrow();
    expect(vault.entries[oauthVaultKey('smartthings')]).toContain('good-token');
  });

  it('reloads a persisted session on construction', () => {
    const vault = fakeVault({
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'stored-token', expiresAt: 0 }),
    });
    const a = new SmartThingsAdapter(vault as never);
    expect(a.isConfigured()).toBe(true);
    expect(a.getMaskedToken()).toContain('stor');
  });

  it('clears both the session and any pasted PAT on disconnect', async () => {
    const vault = fakeVault({
      smartthings: 'pat-token',
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'stored-token', expiresAt: 0 }),
    });
    const a = new SmartThingsAdapter(vault as never);
    await a.clearToken();
    expect(vault.removes).toEqual(['smartthings', oauthVaultKey('smartthings')]);
    expect(a.isConfigured()).toBe(false);
  });
});

describe('SmartThingsAdapter: 401 refresh and replay', () => {
  let http: ReturnType<typeof mockHttp>;
  const savedEnv = { ...process.env };
  let refresh: jest.SpyInstance;

  beforeEach(() => {
    process.env['UMBRA_SMARTTHINGS_CLIENT_ID'] = 'st-client-id';
    process.env['UMBRA_SMARTTHINGS_CLIENT_SECRET'] = 'st-client-secret';
    // Re-spied per test: earlier blocks call jest.restoreAllMocks() in teardown.
    refresh = jest.spyOn(OAuthConnector.prototype, 'refresh')
      .mockResolvedValue({ accessToken: 'fresh-token', expiresAt: Date.now() + 3_600_000 });
  });
  afterEach(() => {
    http?.restore();
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it('refreshes once and replays the call with the new bearer', async () => {
    let attempt = 0;
    http = mockHttp((_m, url) => {
      if (!url.includes('/v1/devices')) return undefined;
      attempt += 1;
      return attempt === 1
        ? { status: 401, text: 'Unauthorized' }
        : { status: 200, text: JSON.stringify(ST_DEVICES) };
    });
    const vault = fakeVault({
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: 0 }),
    });
    const a = new SmartThingsAdapter(vault as never);
    const devices = await a.getDevices();

    expect(devices).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(http.calls[0].headers.Authorization).toBe('Bearer stale');
    expect(http.calls[1].headers.Authorization).toBe('Bearer fresh-token');
  });

  it('keeps the old refresh token when the vendor does not rotate it', async () => {
    http = mockHttp((_m, url) => (url.includes('/v1/devices')
      ? { status: 401, text: 'Unauthorized' }
      : undefined));
    const vault = fakeVault({
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: 0 }),
    });
    const a = new SmartThingsAdapter(vault as never);
    await expect(a.getDevices()).rejects.toThrow();
    expect(decodeTokenSet(vault.entries[oauthVaultKey('smartthings')])?.refreshToken).toBe('rt-1');
  });

  it('does not attempt a refresh for a pasted-PAT platform', async () => {
    // Tuya has no OAuth provider, so there is nothing to refresh: the 401 must
    // surface immediately rather than trigger a pointless round trip.
    let firstList = true;
    http = mockHttp((_m, url) => {
      if (!url.includes('/v1.0/devices')) return undefined;
      // setToken() validates with a device list (must pass), then the
      // getDevices() call below is rejected.
      if (firstList) return { status: 200, text: JSON.stringify({ result: [] }) };
      return { status: 401, text: 'Unauthorized' };
    });
    const a = new TuyaAdapter();
    await a.setToken('pat-token');
    firstList = false;
    await expect(a.getDevices()).rejects.toThrow(/401/);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('catalog: auth mode reporting', () => {
  const savedEnv = { ...process.env };
  function hubFor(...platforms: Parameters<SmartHomeHub['register']>[0][]): SmartHomeHub {
    const hub = new SmartHomeHub();
    platforms.forEach((p) => hub.register(p));
    return hub;
  }

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('reports token mode for self-hosted platforms with no OAuth provider', () => {
    const entry = hubFor(new TuyaAdapter()).catalog()[0];
    expect(entry).toMatchObject({ authMode: 'token', oauthConfigured: false, requiresClientApp: false });
    expect(entry.oauthLabel).toBeUndefined();
  });

  it('reports oauth mode for SmartThings, unconfigured until a vendor app exists', () => {
    delete process.env['UMBRA_SMARTTHINGS_CLIENT_ID'];
    delete process.env['UMBRA_SMARTTHINGS_CLIENT_SECRET'];
    const entry = hubFor(new SmartThingsAdapter()).catalog()[0];
    expect(entry).toMatchObject({
      key: 'smartthings',
      authMode: 'oauth',
      oauthConfigured: false,
      requiresClientApp: true,
      oauthLabel: 'Sign in with Samsung SmartThings',
    });
  });

  it('flips oauthConfigured once the client id and secret are present', () => {
    process.env['UMBRA_SMARTTHINGS_CLIENT_ID'] = 'st-client-id';
    process.env['UMBRA_SMARTTHINGS_CLIENT_SECRET'] = 'st-client-secret';
    expect(hubFor(new SmartThingsAdapter()).catalog()[0].oauthConfigured).toBe(true);
  });
});

describe('SmartThingsPlatformWrapper: OAuth passthrough', () => {
  const savedEnv = { ...process.env };
  let http: ReturnType<typeof mockHttp>;
  /** The legacy service is never the OAuth path — stub only what must not run. */
  const legacySvc = {
    isConfigured: () => false,
    getMaskedToken: () => '',
    clearToken: jest.fn(),
    setToken: jest.fn(),
    validateToken: jest.fn(),
    getSmartHomeDevices: jest.fn(async () => []),
    sendCommand: jest.fn(async () => undefined),
  } as unknown as SmartThingsService;

  beforeEach(() => {
    process.env['UMBRA_SMARTTHINGS_CLIENT_ID'] = 'st-client-id';
    process.env['UMBRA_SMARTTHINGS_CLIENT_SECRET'] = 'st-client-secret';
    jest.clearAllMocks();
  });
  afterEach(() => {
    http?.restore();
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it('exposes the OAuth provider and honours the registered-app gate', () => {
    const w = new SmartThingsPlatformWrapper(legacySvc);
    expect(w.getOAuthProvider()?.name).toBe('Samsung SmartThings');
    expect(w.supportsOAuth()).toBe(true);
    delete process.env['UMBRA_SMARTTHINGS_CLIENT_ID'];
    expect(new SmartThingsPlatformWrapper(legacySvc).supportsOAuth()).toBe(false);
  });

  it('serves devices through the OAuth adapter once a session exists', async () => {
    http = mockHttp((_m, url) => (url.includes('/v1/devices') ? { status: 200, text: JSON.stringify(ST_DEVICES) } : undefined));
    const vault = fakeVault({
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'session-token', expiresAt: 0 }),
    });
    const w = new SmartThingsPlatformWrapper(legacySvc, vault as never);
    const devices = await w.getDevices();
    expect(devices).toHaveLength(1);
    expect(legacySvc.getSmartHomeDevices).not.toHaveBeenCalled();
    expect(http.calls[0].headers.Authorization).toBe('Bearer session-token');
  });

  it('routes commands through the OAuth adapter too', async () => {
    http = mockHttp((_m, url) => (url.includes('/commands') ? { status: 200, text: '{}' } : undefined));
    const vault = fakeVault({
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'session-token', expiresAt: 0 }),
    });
    const w = new SmartThingsPlatformWrapper(legacySvc, vault as never);
    await w.sendCommand('dev-1', 'on');
    expect(legacySvc.sendCommand).not.toHaveBeenCalled();
    expect(http.calls[0].headers.Authorization).toBe('Bearer session-token');
  });

  it('keeps the legacy PAT path when there is no session', async () => {
    (legacySvc.getSmartHomeDevices as jest.Mock).mockResolvedValue([
      { id: 'dev-9', name: 'Legacy Lamp', kind: 'light', switchCapable: true },
    ]);
    const w = new SmartThingsPlatformWrapper(legacySvc);
    const devices = await w.getDevices();
    expect(devices[0].id).toBe('smartthings:dev-9');
    expect(legacySvc.getSmartHomeDevices).toHaveBeenCalled();
  });

  it('clears both the PAT and the OAuth session on disconnect', async () => {
    const vault = fakeVault({
      smartthings: 'pat',
      [oauthVaultKey('smartthings')]: encodeTokenSet({ accessToken: 'session-token', expiresAt: 0 }),
    });
    const w = new SmartThingsPlatformWrapper(legacySvc, vault as never);
    expect(w.isConfigured()).toBe(true);
    await w.clearToken();
    expect(legacySvc.clearToken).toHaveBeenCalled();
    expect(vault.removes).toEqual(['smartthings', oauthVaultKey('smartthings')]);
    expect(w.isConfigured()).toBe(false);
  });
});