import { AudioRouter, parseDeviceList, isCableDevice, findCable, AudioDevice } from './AudioRouter';

const LIST_JSON = JSON.stringify([
  { id: '{0.0.0.00000000}.{spk}', name: 'Speakers (Realtek)', flow: 'render', isDefault: true },
  { id: '{0.0.0.00000000}.{cable}', name: 'CABLE Input (VB-Audio Virtual Cable)', flow: 'render', isDefault: false },
  { id: '{0.0.0.00000000}.{mic}', name: 'Microphone (Realtek)', flow: 'capture', isDefault: true },
  { id: '{0.0.0.00000000}.{cableout}', name: 'CABLE Output (VB-Audio Virtual Cable)', flow: 'capture', isDefault: false },
]);

describe('AudioRouter parsing', () => {
  it('parses the PowerShell list JSON', () => {
    const devices = parseDeviceList(LIST_JSON);
    expect(devices).toHaveLength(4);
    expect(devices[0]).toMatchObject({ flow: 'render', isDefault: true });
    expect(devices[1].name).toContain('CABLE Input');
  });

  it('returns [] for empty/garbage output', () => {
    expect(parseDeviceList('')).toEqual([]);
    expect(parseDeviceList('not json')).toEqual([]);
  });
});

describe('cable detection', () => {
  const devices = parseDeviceList(LIST_JSON);

  it('recognizes VB-Cable render and capture endpoints', () => {
    const renderCable = devices.find(d => d.id.endsWith('{cable}'))!;
    const captureCable = devices.find(d => d.id.endsWith('{cableout}'))!;
    expect(isCableDevice(renderCable)).toBe(true);
    expect(isCableDevice(captureCable)).toBe(true);
  });

  it('does not flag ordinary devices', () => {
    const speakers = devices.find(d => d.name.startsWith('Speakers'))!;
    const mic = devices.find(d => d.name.startsWith('Microphone'))!;
    expect(isCableDevice(speakers)).toBe(false);
    expect(isCableDevice(mic)).toBe(false);
  });

  it('findCable returns the right endpoint per flow', () => {
    expect(findCable(devices, 'render')?.name).toContain('CABLE Input');
    expect(findCable(devices, 'capture')?.name).toContain('CABLE Output');
  });

  it('matches plain "Virtual Audio Cable" as a render cable', () => {
    const classic: AudioDevice = { id: 'x', name: 'Line 1 (Virtual Audio Cable)', flow: 'render' };
    expect(isCableDevice(classic)).toBe(true);
  });
});

describe('AudioRouter platform guards', () => {
  const router = new AudioRouter({ dataDir: '/tmp/umbra' });

  it('lists no devices off-Windows', async () => {
    if (process.platform === 'win32') return;
    expect(await router.listDevices()).toEqual([]);
  });

  it('rejects play() off-Windows', async () => {
    if (process.platform === 'win32') return;
    await expect(router.play(Buffer.from('RIFF'))).rejects.toThrow(/Windows-only/);
  });
});
