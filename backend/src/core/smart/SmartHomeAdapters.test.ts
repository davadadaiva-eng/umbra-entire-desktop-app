/**
 * SmartHomeAdapters.test.ts — platform adapter tests with a mocked HTTP layer.
 *
 * HttpBridge.request is the single network seam for every token-based
 * adapter, so stubbing it covers Home Assistant, Hubitat and Tuya without
 * touching the network. Covered here:
 *  - configuration gating (url + token required where applicable)
 *  - device listing, normalization and namespaced ids
 *  - command URLs/payloads (including HA's domain-aware service calls)
 *  - connect flow: validate-before-persist (failed connect must not store)
 *  - 401 handling: human error message, credential untouched
 */

import { HttpBridge } from '../agent/HttpBridge';
import {
  HomeAssistantAdapter,
  HubitatAdapter,
  TuyaAdapter,
} from './SmartHomeAdapters';
import type { SmartHomeDeviceV2 } from './SmartHomePlatform';

interface HttpCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface HttpMock {
  calls: HttpCall[];
  restore(): void;
}

/**
 * Install a routing stub for HttpBridge.request. The handler returns
 * { status, text } for known routes or undefined to fail loudly on
 * unexpected requests. Every call is recorded in `calls`.
 */
function mockHttp(handler: (method: string, url: string) => { status: number; text?: string } | undefined): HttpMock {
  const calls: HttpCall[] = [];
  const spy = jest.spyOn(HttpBridge, 'request').mockImplementation(((opts: {
    url: string; method?: string; headers?: Record<string, string>; body?: unknown;
  }) => {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    calls.push({ method, url: opts.url, headers, body: opts.body });
    const res = handler(method, opts.url);
    if (!res) throw new Error(`mockHttp: no route for ${method} ${opts.url}`);
    return Promise.resolve({ status: res.status, data: null, text: res.text ?? '' });
  }) as typeof HttpBridge.request);
  return { calls, restore: () => spy.mockRestore() };
}

const HA_STATES = [
  { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen Light' } },
  { entity_id: 'switch.coffee', state: 'off', attributes: { friendly_name: 'Coffee Plug' } },
  { entity_id: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Temp' } }, // filtered out
  { entity_id: 'fan.ceiling', state: 'unavailable', attributes: { friendly_name: 'Fan' } },
];

describe('HomeAssistantAdapter', () => {
  let http: HttpMock;
  afterEach(() => http?.restore());

  it('is not configured without url or token', () => {
    expect(new HomeAssistantAdapter({ url: '', token: '' }).isConfigured()).toBe(false);
  });

  it('lists devices with namespaced ids and HA state mapping', async () => {
    http = mockHttp((_m, url) => {
      if (url.endsWith('/api/states')) return { status: 200, text: JSON.stringify(HA_STATES) };
      return undefined;
    });
    const a = new HomeAssistantAdapter({ url: 'http://ha.test:8123/', token: 'ha-token' });
    const devices = await a.getDevices();
    expect(devices.map((d) => d.id)).toEqual([
      'homeassistant:light.kitchen',
      'homeassistant:switch.coffee',
      'homeassistant:fan.ceiling',
    ]);
    expect(devices[0]).toMatchObject({ nativeId: 'light.kitchen', kind: 'light', switchState: 'on', switchCapable: true });
    expect(devices[2]).toMatchObject({ switchState: null, online: false });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('http://ha.test:8123/api/states');
    expect(http.calls[0].headers['Authorization']).toBe('Bearer ha-token');
  });

  it('sends commands to the entity domain service (light.* → light/turn_on)', async () => {
    http = mockHttp(() => ({ status: 200, text: '' }));
    const a = new HomeAssistantAdapter({ url: 'http://ha.test:8123', token: 'ha-token' });
    await a.sendCommand('light.kitchen', 'on');
    await a.sendCommand('switch.coffee', 'off');
    expect(http.calls[0].url).toBe('http://ha.test:8123/api/services/light/turn_on');
    expect(http.calls[1].url).toBe('http://ha.test:8123/api/services/switch/turn_off');
    expect(http.calls[0].body).toEqual({ entity_id: 'light.kitchen' });
  });

  it('maps 401 to a human error mentioning the status', async () => {
    http = mockHttp(() => ({ status: 401, text: '{"message": "Unauthorized"}' }));
    const a = new HomeAssistantAdapter({ url: 'http://ha.test:8123', token: 'bad-token' });
    await expect(a.getDevices()).rejects.toThrow(/401/);
  });

  it('setToken validates before persisting (failed connect stores nothing)', async () => {
    http = mockHttp((_m, url) => (url.endsWith('/api/states')
      ? { status: 401, text: '{"message": "Invalid access token"}' }
      : undefined));
    const vaultCalls: string[] = [];
    const vault = {
      isUnlocked: true,
      find: () => undefined,
      set: () => void vaultCalls.push('set'),
      remove: () => void vaultCalls.push('remove'),
    };
    const a = new HomeAssistantAdapter({ url: '', token: '' }, vault as never);
    await expect(a.setToken('bad-token', 'http://ha.test:8123')).rejects.toThrow(/401/);
    expect(vaultCalls).toEqual([]); // nothing persisted on failed connect
    expect(a.isConfigured()).toBe(false);
  });

  it('setToken stores the token in the vault on success and reports device count', async () => {
    http = mockHttp((_m, url) => (url.endsWith('/api/states')
      ? { status: 200, text: JSON.stringify(HA_STATES) }
      : undefined));
    const vaultCalls: string[] = [];
    const vault = {
      isUnlocked: true,
      find: () => undefined,
      set: (e: { service: string }) => void vaultCalls.push(`set:${e.service}`),
      remove: () => void vaultCalls.push('remove'),
    };
    const a = new HomeAssistantAdapter({ url: '', token: '' }, vault as never);
    const res = await a.setToken('good-token', 'http://ha.test:8123');
    expect(res.ok).toBe(true);
    expect(res.deviceCount).toBe(3); // sensor entity filtered out
    expect(vaultCalls).toEqual(['set:homeassistant']);
    expect(a.isConfigured()).toBe(true);
  });
});

describe('HubitatAdapter', () => {
  let http: HttpMock;
  afterEach(() => http?.restore());

  it('requires both hub url and token to be configured', () => {
    expect(new HubitatAdapter({ hubUrl: '', token: '' }).isConfigured()).toBe(false);
    expect(new HubitatAdapter({ hubUrl: 'http://hub.test', token: '' }).isConfigured()).toBe(false);
    expect(new HubitatAdapter({ hubUrl: '', token: 'tok' }).isConfigured()).toBe(false);
    expect(new HubitatAdapter({ hubUrl: 'http://hub.test', token: 'tok' }).isConfigured()).toBe(true);
  });

  it('lists devices through the Maker API with namespaced ids', async () => {
    http = mockHttp((_m, url) => {
      if (url.startsWith('http://hub.test/apps/api/1/devices?')) return {
        status: 200,
        text: JSON.stringify([
          { id: 31, label: 'Porch Light', type: 'Generic A19 Bulb' },
          { id: 32, label: 'Coffee Maker', type: 'Outlet' },
        ]),
      };
      return undefined;
    });
    const a = new HubitatAdapter({ hubUrl: 'http://hub.test', token: 'maker-tok' });
    const devices = await a.getDevices();
    expect(devices.map((d) => d.id)).toEqual(['hubitat:31', 'hubitat:32']);
    expect(devices[0]).toMatchObject({ name: 'Porch Light', kind: 'light' });
    expect(devices[1]).toMatchObject({ kind: 'plug' });
    expect(http.calls[0].url).toContain('access_token=maker-tok');
  });

  it('sends commands to the Maker API device endpoint', async () => {
    http = mockHttp(() => ({ status: 200, text: '' }));
    const a = new HubitatAdapter({ hubUrl: 'http://hub.test', token: 'maker-tok' });
    await a.sendCommand('31', 'on');
    expect(http.calls[0].url).toBe('http://hub.test/apps/api/1/devices/31/on?access_token=maker-tok');
  });

  it('surfaces a 401 as a human-readable token error', async () => {
    http = mockHttp(() => ({ status: 401, text: 'unauthorized' }));
    const a = new HubitatAdapter({ hubUrl: 'http://hub.test', token: 'expired' });
    await expect(a.getDevices()).rejects.toThrow(/401/);
  });

  it('setToken with a url updates the hub url before validating', async () => {
    http = mockHttp((_m, url) => (url.startsWith('http://newhub.test/')
      ? { status: 200, text: '[]' }
      : undefined));
    const a = new HubitatAdapter({ hubUrl: '', token: '' });
    await a.setToken('tok', 'http://newhub.test');
    expect(a.isConfigured()).toBe(true);
    expect(http.calls[0].url).toContain('http://newhub.test/apps/api/1/devices');
  });
});

describe('TuyaAdapter', () => {
  let http: HttpMock;
  afterEach(() => http?.restore());

  it('is not configured without a token (endpoint has a default)', () => {
    expect(new TuyaAdapter({ endpoint: 'https://openapi.tuyaus.com', token: '' }).isConfigured()).toBe(false);
    expect(new TuyaAdapter({ endpoint: 'https://openapi.tuyaus.com', token: 'tok' }).isConfigured()).toBe(true);
  });

  it('lists devices from the IoT cloud with namespaced ids', async () => {
    http = mockHttp((_m, url) => {
      if (url === 'https://openapi.tuyaeu.com/v1.0/devices') return {
        status: 200,
        text: JSON.stringify({ result: { list: [
          { id: 'bf7a1b', name: 'Bedroom Bulb', category: 'dj', online: true },
          { id: 'bf7a2c', name: 'Heater Plug', category: 'cz', online: false },
        ] } }),
      };
      return undefined;
    });
    const a = new TuyaAdapter({ endpoint: 'https://openapi.tuyaeu.com', token: 'tuya-tok' });
    const devices = await a.getDevices();
    expect(devices.map((d) => d.id)).toEqual(['tuya:bf7a1b', 'tuya:bf7a2c']);
    expect(devices[0]).toMatchObject({ kind: 'light', online: true });
    expect(devices[1]).toMatchObject({ kind: 'plug', online: false });
    expect(http.calls[0].headers['Authorization']).toBe('Bearer tuya-tok');
  });

  it('sends commands to the device commands endpoint with boolean value', async () => {
    http = mockHttp(() => ({ status: 200, text: '' }));
    const a = new TuyaAdapter({ endpoint: 'https://openapi.tuyaeu.com', token: 'tuya-tok' });
    await a.sendCommand('bf7a1b', 'on');
    await a.sendCommand('bf7a1b', 'off');
    expect(http.calls[0].url).toBe('https://openapi.tuyaeu.com/v1.0/devices/bf7a1b/commands');
    expect(http.calls[0].body).toEqual({ commands: [{ code: 'switch_1', value: true }] });
    expect(http.calls[1].body).toEqual({ commands: [{ code: 'switch_1', value: false }] });
  });

  it('maps 401 to a human error and keeps the adapter unconfigured on failed connect', async () => {
    http = mockHttp((_m, url) => (url.endsWith('/v1.0/devices')
      ? { status: 401, text: '{"msg": "invalid token"}' }
      : undefined));
    const a = new TuyaAdapter({ endpoint: 'https://openapi.tuyaeu.com', token: '' });
    await expect(a.setToken('expired-token', 'https://openapi.tuyaeu.com')).rejects.toThrow(/401/);
    expect(a.isConfigured()).toBe(false);
    await expect(a.getDevices()).rejects.toThrow(/401/);
  });
});

describe('cross-adapter invariants', () => {
  it('normalized devices always carry namespaced ids and platform metadata', async () => {
    const http = mockHttp((_m, url) => {
      if (url.endsWith('/api/states')) return { status: 200, text: JSON.stringify([HA_STATES[1]]) };
      if (url.startsWith('http://hub.test/')) return { status: 200, text: JSON.stringify([{ id: 9, label: 'X', type: 'Outlet' }]) };
      if (url.includes('/v1.0/devices')) return { status: 200, text: JSON.stringify({ result: { list: [{ id: 't1', name: 'Y', category: 'dj' }] } }) };
      return undefined;
    });
    const devices: SmartHomeDeviceV2[] = [
      ...await new HomeAssistantAdapter({ url: 'http://ha.test:8123', token: 't' }).getDevices(),
      ...await new HubitatAdapter({ hubUrl: 'http://hub.test', token: 't' }).getDevices(),
      ...await new TuyaAdapter({ endpoint: 'https://openapi.tuyaeu.com', token: 't' }).getDevices(),
    ];
    http.restore();
    expect(devices).toHaveLength(3);
    for (const d of devices) {
      expect(d.id).toBe(`${d.platform}:${d.nativeId}`);
      expect(d.platformLabel.length).toBeGreaterThan(0);
    }
  });
});
