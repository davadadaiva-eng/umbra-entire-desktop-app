import { SmartThingsService, switchCommandPayload } from './SmartThingsService';

// ── Test harness: minimal mock of the HTTPS layer ────────────────
type Handler = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

function makeService(handler: Handler): SmartThingsService {
  const svc = new SmartThingsService({ enabled: true, token: 'test-token', baseUrl: 'https://api.smartthings.test' });
  // Route the service's private request() through the mock handler — request()
  // resolves with the parsed body (and throws on non-2xx), like the real one.
  (svc as unknown as { request: Handler }).request = (async (method: string, path: string, body?: unknown) => {
    const res = await handler(method, path, body);
    if (res.status < 200 || res.status >= 300) throw new Error(`SmartThings HTTP ${res.status}`);
    return res.body;
  }) as never;
  return svc;
}

const DEVICE = (id: string, label: string, caps: string[]) => ({
  deviceId: id,
  name: label,
  label,
  components: [{ id: 'main', capabilities: caps.map((c) => ({ id: c })) }],
});

const FIXTURE_DEVICES = [
  DEVICE('lamp-1', 'Desk Lamp', ['switch', 'switchLevel', 'colorControl']),
  DEVICE('plug-1', 'Coffee Plug', ['switch', 'outlet']),
  DEVICE('sensor-1', 'Door Sensor', ['contactSensor', 'battery']),
];

describe('switchCommandPayload', () => {
  it('uses the standard switch capability payload shape', () => {
    expect(switchCommandPayload('on')).toEqual({
      commands: [{ component: 'main', capability: 'switch', command: 'on', arguments: [] }],
    });
    expect(switchCommandPayload('off')).toEqual({
      commands: [{ component: 'main', capability: 'switch', command: 'off', arguments: [] }],
    });
  });
});

describe('SmartThingsService.listDevices', () => {
  it('fetches devices with a Bearer token', async () => {
    const svc = makeService(async (method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/v1/devices?max=200');
      return { status: 200, body: { items: FIXTURE_DEVICES } };
    });
    const devices = await svc.listDevices();
    expect(devices).toHaveLength(3);
    expect(devices[0].deviceId).toBe('lamp-1');
  });

  it('follows pagination next links', async () => {
    const pages: string[] = ['/v1/devices?max=200', '/v1/devices?max=200&page=2'];
    const svc = makeService(async (_method, path) => {
      if (path === pages[0]) {
        return { status: 200, body: { items: [FIXTURE_DEVICES[0]], next: pages[1] } };
      }
      return { status: 200, body: { items: [FIXTURE_DEVICES[1], FIXTURE_DEVICES[2]] } };
    });
    const devices = await svc.listDevices();
    expect(devices.map((d) => d.deviceId)).toEqual(['lamp-1', 'plug-1', 'sensor-1']);
  });
});

describe('SmartThingsService.sendCommand', () => {
  it('POSTs the switch payload to /commands', async () => {
    let seenBody: unknown;
    const svc = makeService(async (method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/v1/devices/lamp-1/commands');
      seenBody = body;
      return { status: 200, body: {} };
    });
    await svc.sendCommand('lamp-1', 'on');
    expect(seenBody).toEqual(switchCommandPayload('on'));
  });
});

describe('SmartThingsService.controlByName', () => {
  it('resolves a device by fuzzy name and sends the command', async () => {
    let commandPath = '';
    const svc = makeService(async (method, path, body) => {
      if (method === 'GET' && path.startsWith('/v1/devices')) {
        return { status: 200, body: { items: FIXTURE_DEVICES } };
      }
      commandPath = path;
      expect(body).toEqual(switchCommandPayload('off'));
      return { status: 200, body: {} };
    });
    const res = await svc.controlByName('coffee', 'off');
    expect(res.deviceId).toBe('plug-1');
    expect(res.command).toBe('off');
    expect(commandPath).toBe('/v1/devices/plug-1/commands');
  });

  it('throws for unknown device names', async () => {
    const svc = makeService(async () => ({ status: 200, body: { items: FIXTURE_DEVICES } }));
    await expect(svc.controlByName('nonexistent', 'on')).rejects.toThrow(/No SmartThings device/);
  });
});

describe('SmartThingsService.getSmartHomeDevices', () => {
  it('marks only switch-capable devices and hydrates their state', async () => {
    const svc = makeService(async (method, path) => {
      if (path.startsWith('/v1/devices/')) {
        const id = path.split('/')[3];
        return { status: 200, body: { switch: { value: id === 'lamp-1' ? 'on' : 'off' } } };
      }
      if (path === '/v1/rooms') return { status: 200, body: { items: [] } };
      if (method === 'GET') return { status: 200, body: { items: FIXTURE_DEVICES } };
      return { status: 200, body: {} };
    });
    const devices = await svc.getSmartHomeDevices();
    expect(devices).toHaveLength(3);
    expect(devices.find((d) => d.id === 'lamp-1')).toMatchObject({ switchCapable: true, switchState: 'on', kind: 'light' });
    expect(devices.find((d) => d.id === 'plug-1')).toMatchObject({ switchCapable: true, switchState: 'off', kind: 'plug' });
    expect(devices.find((d) => d.id === 'sensor-1')).toMatchObject({ switchCapable: false, switchState: null, kind: 'sensor' });
  });
});
