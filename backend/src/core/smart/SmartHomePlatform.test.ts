import { SmartHomeHub, fuzzyScore, type SmartHomePlatform, type SmartHomeDeviceV2 } from './SmartHomePlatform';

function makePlatform(key: string, devices: SmartHomeDeviceV2[], fail = false): SmartHomePlatform {
  const sent: Array<{ id: string; command: 'on' | 'off' }> = [];
  const p: SmartHomePlatform = {
    key,
    label: key,
    help: `${key} test adapter`,
    isConfigured: () => true,
    getDevices: async () => {
      if (fail) throw new Error(`${key} offline`);
      return devices;
    },
    sendCommand: async (nativeId, command) => {
      sent.push({ id: nativeId, command });
    },
  };
  (p as any).__sent = sent;
  return p;
}

const stLamp: SmartHomeDeviceV2 = {
  id: 'smartthings:lamp-1',
  nativeId: 'lamp-1',
  platform: 'smartthings',
  platformLabel: 'SmartThings',
  name: 'Desk Lamp',
  kind: 'light',
  manufacturer: 'Signify',
  room: 'Office',
  switchCapable: true,
  switchState: 'off',
  online: true,
};

const haPlug: SmartHomeDeviceV2 = {
  id: 'homeassistant:switch.coffee',
  nativeId: 'switch.coffee',
  platform: 'homeassistant',
  platformLabel: 'Home Assistant',
  name: 'Coffee Plug',
  kind: 'plug',
  manufacturer: 'Sonoff',
  room: 'Kitchen',
  switchCapable: true,
  switchState: 'on',
  online: true,
};

describe('SmartHomeHub', () => {
  it('aggregates devices across platforms with namespaced ids', async () => {
    const hub = new SmartHomeHub();
    hub.register(makePlatform('smartthings', [stLamp]));
    hub.register(makePlatform('homeassistant', [haPlug]));
    const devices = await hub.getDevices();
    expect(devices.map((d) => d.id)).toEqual(['smartthings:lamp-1', 'homeassistant:switch.coffee']);
  });

  it('keeps working when one platform fails', async () => {
    const hub = new SmartHomeHub();
    hub.register(makePlatform('smartthings', [stLamp]));
    hub.register(makePlatform('homeassistant', [haPlug], true));
    const devices = await hub.getDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].platform).toBe('smartthings');
  });

  it('routes a command by namespaced id to the right platform', async () => {
    const a = makePlatform('smartthings', [stLamp]);
    const b = makePlatform('homeassistant', [haPlug]);
    const hub = new SmartHomeHub();
    hub.register(a);
    hub.register(b);
    const res = await hub.sendCommand('homeassistant:switch.coffee', 'off');
    expect(res.platform).toBe('homeassistant');
    expect((b as any).__sent).toEqual([{ id: 'switch.coffee', command: 'off' }]);
    expect((a as any).__sent).toEqual([]);
  });

  it('throws for an unknown platform key', async () => {
    const hub = new SmartHomeHub();
    hub.register(makePlatform('smartthings', [stLamp]));
    await expect(hub.sendCommand('nosuch:x', 'on')).rejects.toThrow(/No connected smart home platform/);
  });

  it('controls by fuzzy name across platforms', async () => {
    const b = makePlatform('homeassistant', [haPlug]);
    const hub = new SmartHomeHub();
    hub.register(makePlatform('smartthings', [stLamp]));
    hub.register(b);
    const res = await hub.controlByName('coffee', 'off');
    expect(res.deviceId).toBe('homeassistant:switch.coffee');
    expect(res.name).toBe('Coffee Plug');
    expect((b as any).__sent).toEqual([{ id: 'switch.coffee', command: 'off' }]);
  });

  it('throws a clear error when no device matches by name', async () => {
    const hub = new SmartHomeHub();
    hub.register(makePlatform('smartthings', [stLamp]));
    await expect(hub.controlByName('nonexistent', 'on')).rejects.toThrow(/No device matching/);
  });

  it('catalog reports configured state and masked tokens', () => {
    const hub = new SmartHomeHub();
    hub.register({
      ...makePlatform('smartthings', [stLamp]),
      getMaskedToken: () => 'abcd••••wxyz',
    });
    const catalog = hub.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].configured).toBe(true);
    expect(catalog[0].tokenMasked).toBe('abcd••••wxyz');
  });
});

describe('fuzzyScore', () => {
  it('ranks exact → substring → token overlap', () => {
    expect(fuzzyScore('desk lamp', 'desk lamp')).toBe(100);
    expect(fuzzyScore('lamp', 'desk lamp')).toBe(80);
    expect(fuzzyScore('desk light', 'desk lamp')).toBeGreaterThan(0);
    expect(fuzzyScore('desk light', 'coffee plug')).toBe(0);
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});
