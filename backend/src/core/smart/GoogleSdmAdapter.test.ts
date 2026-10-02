/**
 * GoogleSdmAdapter.test.ts — the official Google Smart Device Management API
 * adapter, with the network stubbed at the same seam every other adapter uses
 * (HttpBridge.request).
 *
 * Covered here:
 *  - listing + normalization of SDM's trait bags into the shared device model
 *  - room resolution from structures/rooms resource ids
 *  - thermostat on/off mapping to ThermostatMode.SetMode, including restoring
 *    a valid mode when the device advertises a restricted set
 *  - an explicit rejection for device types Google has no on/off for
 *  - project-id validation and the OAuth-only credential story
 */

import { HttpBridge } from '../agent/HttpBridge';
import { GoogleSdmAdapter } from './GoogleSdmAdapter';
import { buildSmartHomeHub } from './SmartHomeAdapters';
import { OAuthConnector } from '../mcp/OAuthConnector';
import { encodeTokenSet, oauthVaultKey } from './SmartHomeOAuth';

interface HttpCall { method: string; url: string; headers: Record<string, string>; body: unknown; }

function mockHttp(handler: (method: string, url: string) => { status: number; text?: string } | undefined): {
  calls: HttpCall[];
  restore(): void;
} {
  const calls: HttpCall[] = [];
  const spy = jest.spyOn(HttpBridge, 'request').mockImplementation(((opts: {
    url: string; method?: string; headers?: Record<string, string>; body?: unknown;
  }) => {
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, url: opts.url, headers: opts.headers || {}, body: opts.body });
    const res = handler(method, opts.url);
    if (!res) throw new Error(`mockHttp: no route for ${method} ${opts.url}`);
    return Promise.resolve({ status: res.status, data: null, text: res.text ?? '' });
  }) as typeof HttpBridge.request);
  return { calls, restore: () => spy.mockRestore() };
}

function fakeVault(seed: Record<string, string> = {}) {
  const entries: Record<string, string> = { ...seed };
  return {
    entries,
    sets: [] as string[],
    find: (s: string) => (entries[s] !== undefined ? { secret: entries[s] } : undefined),
    set: (e: { service: string; secret: string }) => { entries[e.service] = e.secret; return true; },
    remove: (s: string) => delete entries[s],
    isUnlocked: true,
  };
}

const ENTERPRISE = 'https://smartdevicemanagement.googleapis.com/v1/enterprises/proj-1';

const THERMOSTAT = {
  name: 'devices/thermo-1',
  type: 'sdm.devices.types.THERMOSTAT',
  parentRelations: [{ parent: 'structures/home-1', room: 'rooms/hall-1' }],
  traits: {
    'sdm.devices.traits.Info': { customName: 'Hallway Nest' },
    'sdm.devices.traits.Connectivity': { status: 'ONLINE' },
    'sdm.devices.traits.ThermostatMode': { mode: 'HEAT', availableModes: ['OFF', 'HEAT', 'COOL'] },
    'sdm.devices.traits.Temperature': { ambientTemperatureCelsius: 19.5 },
  },
};

const CAMERA = {
  name: 'devices/cam-1',
  type: 'sdm.devices.types.CAMERA',
  parentRelations: [{ parent: 'structures/home-1' }],
  traits: {
    'sdm.devices.traits.Info': { customName: 'Front Door Cam' },
    'sdm.devices.traits.Connectivity': { status: 'ONLINE' },
  },
};

const STRUCTURES = { structures: [{ name: 'structures/home-1', traits: { 'sdm.devices.traits.Info': { customName: 'My Home' } } }] };
const ROOMS = { rooms: [{ name: 'rooms/hall-1', traits: { 'sdm.devices.traits.Info': { customName: 'Hallway' } } }] };

describe('GoogleSdmAdapter', () => {
  let http: ReturnType<typeof mockHttp>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env['UMBRA_GOOGLE_PROJECT_ID'] = 'proj-1';
    process.env['UMBRA_GOOGLE_CLIENT_ID'] = 'goog-client-id';
  });

  afterEach(() => {
    http?.restore();
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  /** Signs the adapter in by seeding the vault, as the OAuth flow would. */
  function signedIn(extra: Record<string, string> = {}) {
    return encodeTokenSet({ accessToken: 'goog-access-token', refreshToken: 'goog-refresh', expiresAt: 0, ...extra });
  }

  it('lists devices and normalizes SDM traits into the shared model', async () => {
    http = mockHttp((_m, url) => {
      if (url.endsWith('/devices')) return { status: 200, text: JSON.stringify({ devices: [THERMOSTAT, CAMERA] }) };
      if (url.endsWith('/structures')) return { status: 200, text: JSON.stringify(STRUCTURES) };
      if (url.includes('/rooms')) return { status: 200, text: JSON.stringify(ROOMS) };
      return undefined;
    });
    const a = new GoogleSdmAdapter();
    const devices = await a.getDevices({ withStates: true });

    expect(devices.map((d) => d.id)).toEqual(['googlehome:thermo-1', 'googlehome:cam-1']);
    expect(devices[0]).toMatchObject({
      name: 'Hallway Nest',
      kind: 'thermostat',
      room: 'Hallway',
      switchCapable: true,
      switchState: 'on',
      online: true,
    });
    // Google has no on/off for a camera, so it must not pretend to offer one.
    expect(devices[1]).toMatchObject({ kind: 'camera', switchCapable: false, switchState: null });
  });

  it('reports an offline device as offline', async () => {
    http = mockHttp((_m, url) => {
      if (url.endsWith('/devices')) {
        return { status: 200, text: JSON.stringify({ devices: [{ ...THERMOSTAT, traits: { ...THERMOSTAT.traits, 'sdm.devices.traits.Connectivity': { status: 'OFFLINE' } } }] }) };
      }
      if (url.endsWith('/structures')) return { status: 200, text: JSON.stringify(STRUCTURES) };
      if (url.includes('/rooms')) return { status: 200, text: JSON.stringify(ROOMS) };
      return undefined;
    });
    expect((await new GoogleSdmAdapter().getDevices())[0].online).toBe(false);
  });

  it('sends the OAuth access token as the bearer', async () => {
    http = mockHttp((_m, url) => {
      if (url.endsWith('/devices')) return { status: 200, text: JSON.stringify({ devices: [THERMOSTAT] }) };
      if (url.endsWith('/structures')) return { status: 200, text: JSON.stringify(STRUCTURES) };
      if (url.includes('/rooms')) return { status: 200, text: JSON.stringify(ROOMS) };
      return undefined;
    });
    const vault = fakeVault({ [oauthVaultKey('googlehome')]: signedIn() });
    await new GoogleSdmAdapter(vault as never).getDevices();
    expect(http.calls[0].headers.Authorization).toBe('Bearer goog-access-token');
  });

  it('turns a thermostat off with ThermostatMode.SetMode', async () => {
    http = mockHttp((m, url) => {
      if (url.endsWith('/devices/thermo-1')) return { status: 200, text: JSON.stringify(THERMOSTAT) };
      if (url.includes(':executeCommand')) return { status: 200, text: '{}' };
      return undefined;
    });
    const vault = fakeVault({ [oauthVaultKey('googlehome')]: signedIn() });
    await new GoogleSdmAdapter(vault as never).sendCommand('thermo-1', 'off');

    const call = http.calls.find((c) => c.url.includes(':executeCommand'))!;
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({
      command: 'sdm.devices.commands.ThermostatMode.SetMode',
      params: { mode: 'OFF' },
    });
  });

  it('keeps the current mode when turning a thermostat back on', async () => {
    http = mockHttp((m, url) => {
      if (url.endsWith('/devices/thermo-1')) return { status: 200, text: JSON.stringify(THERMOSTAT) };
      if (url.includes(':executeCommand')) return { status: 200, text: '{}' };
      return undefined;
    });
    const vault = fakeVault({ [oauthVaultKey('googlehome')]: signedIn() });
    await new GoogleSdmAdapter(vault as never).sendCommand('thermo-1', 'on');
    const call = http.calls.find((c) => c.url.includes(':executeCommand'))!;
    expect(call.body).toMatchObject({ params: { mode: 'HEAT' } });
  });

  it('restores a mode the thermostat actually advertises when it was off', async () => {
    // HEAT-only device: turning it on must not command HEATCOOL.
    const coolOnly = {
      ...THERMOSTAT,
      traits: {
        ...THERMOSTAT.traits,
        'sdm.devices.traits.ThermostatMode': { mode: 'OFF', availableModes: ['OFF', 'COOL'] },
      },
    };
    http = mockHttp((_m, url) => {
      if (url.endsWith('/devices/thermo-1')) return { status: 200, text: JSON.stringify(coolOnly) };
      if (url.includes(':executeCommand')) return { status: 200, text: '{}' };
      return undefined;
    });
    const vault = fakeVault({ [oauthVaultKey('googlehome')]: signedIn() });
    await new GoogleSdmAdapter(vault as never).sendCommand('thermo-1', 'on');
    expect(http.calls.find((c) => c.url.includes(':executeCommand'))!.body).toMatchObject({ params: { mode: 'COOL' } });
  });

  it('explains that cameras have no on/off instead of sending a doomed command', async () => {
    http = mockHttp((_m, url) => (url.endsWith('/devices/cam-1') ? { status: 200, text: JSON.stringify(CAMERA) } : undefined));
    const vault = fakeVault({ [oauthVaultKey('googlehome')]: signedIn() });
    await expect(new GoogleSdmAdapter(vault as never).sendCommand('cam-1', 'off'))
      .rejects.toThrow(/no on\/off command for camera devices/);
    expect(http.calls.some((c) => c.url.includes(':executeCommand'))).toBe(false);
  });

  it('requires the Device Access project id before touching the network', async () => {
    delete process.env['UMBRA_GOOGLE_PROJECT_ID'];
    http = mockHttp(() => undefined);
    await expect(new GoogleSdmAdapter().getDevices()).rejects.toThrow(/UMBRA_GOOGLE_PROJECT_ID/);
    expect(http.calls).toHaveLength(0);
  });

  it('refuses a pasted token — SDM is OAuth-only', async () => {
    await expect(new GoogleSdmAdapter().setToken('some-token')).rejects.toThrow(/no personal access token/);
  });

  it('reports oauth auth mode in the catalog', async () => {
    const a = new GoogleSdmAdapter();
    expect(a.getOAuthProvider()?.name).toBe('Google Home');
    expect(a.supportsOAuth()).toBe(true);
    expect(a.isConfigured()).toBe(false);
  });

  it('persists the token set after a successful sign-in', async () => {
    http = mockHttp((_m, url) => {
      if (url.endsWith('/devices')) return { status: 200, text: JSON.stringify({ devices: [THERMOSTAT] }) };
      if (url.endsWith('/structures')) return { status: 200, text: JSON.stringify(STRUCTURES) };
      if (url.includes('/rooms')) return { status: 200, text: JSON.stringify(ROOMS) };
      return undefined;
    });
    jest.spyOn(OAuthConnector.prototype, 'complete').mockResolvedValue({
      key: 'googlehome',
      tokens: { accessToken: 'fresh-goog-token', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
    });

    const vault = fakeVault();
    const a = new GoogleSdmAdapter(vault as never);
    const res = await a.completeOAuth('code-1', 'st');
    expect(res).toMatchObject({ ok: true, deviceCount: 1 });
    expect(vault.entries[oauthVaultKey('googlehome')]).toContain('fresh-goog-token');
    expect(a.isConfigured()).toBe(true);
  });

  it('surfaces a revoked grant as an actionable error', async () => {
    http = mockHttp(() => ({ status: 403, text: JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }) }));
    const vault = fakeVault({ [oauthVaultKey('googlehome')]: signedIn() });
    await expect(new GoogleSdmAdapter(vault as never).getDevices()).rejects.toThrow();
  });
});
describe('hub registration', () => {
  it('registers the official SDM adapter, not the CLI bridge, as Google Home', () => {
    const hub = buildSmartHomeHub({});
    const keys = hub.catalog().map((c) => c.key);

    expect(keys).toContain('googlehome');
    // The local bridge survives under its own key for anyone who already runs it.
    expect(keys).toContain('ghome');

    const google = hub.catalog().find((c) => c.key === 'googlehome')!;
    expect(google.label).toBe('Google Home');
    expect(google.authMode).toBe('oauth');
    expect(google.requiresClientApp).toBe(true);
  });

  it('keeps SmartThings and Alexa registered alongside the new Google path', () => {
    const keys = buildSmartHomeHub({}).catalog().map((c) => c.key);
    expect(keys).toContain('smartthings');
    expect(keys).toContain('alexa');
  });
});
