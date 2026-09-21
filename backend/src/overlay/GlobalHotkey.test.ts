import { GlobalHotkey, parseHotkey, buildKeyCheck } from './GlobalHotkey';
import { eventBus } from '../core/EventBus';

describe('parseHotkey', () => {
  it('parses a modifier + key combo into VK codes', () => {
    expect(parseHotkey('Ctrl+Shift+Space')).toEqual([17, 16, 32]);
    expect(parseHotkey('Cmd+K')).toEqual([91, 75]);
    expect(parseHotkey('F5')).toEqual([0x74]);
  });

  it('ignores unknown tokens and empty combos', () => {
    expect(parseHotkey('')).toEqual([]);
    expect(parseHotkey('Foo+Bar')).toEqual([]);
  });
});

describe('buildKeyCheck', () => {
  it('returns true only when every key is down', async () => {
    const down = new Set([17, 16]);
    const check = buildKeyCheck([17, 16, 32], async vk => down.has(vk));
    await expect(check()).resolves.toBe(false);
    down.add(32);
    await expect(check()).resolves.toBe(true);
  });
});

describe('GlobalHotkey', () => {
  it('emits overlay:toggle on the rising edge only', async () => {
    const toggle = jest.fn();
    eventBus.on('overlay:toggle', toggle);

    let down = false;
    const hk = new GlobalHotkey({
      combo: 'Ctrl+Shift+Space',
      check: async () => down,
      pollMs: 1000,
    });

    await hk.poll();
    expect(toggle).not.toHaveBeenCalled();

    down = true;
    await hk.poll();
    expect(toggle).toHaveBeenCalledTimes(1);

    // Held down — no repeat fire.
    await hk.poll();
    expect(toggle).toHaveBeenCalledTimes(1);

    // Released, then pressed again — fires once more.
    down = false;
    await hk.poll();
    down = true;
    await hk.poll();
    expect(toggle).toHaveBeenCalledTimes(2);

    eventBus.off('overlay:toggle', toggle);
  });

  it('emits overlay:command with the command payload', async () => {
    const cmd = jest.fn();
    eventBus.on('overlay:command', cmd);
    const hk = new GlobalHotkey({
      combo: 'Ctrl+Shift+Space',
      event: 'overlay:command',
      command: 'finish this',
      check: async () => true,
      pollMs: 1000,
    });
    await hk.poll();
    expect(cmd).toHaveBeenCalledWith('finish this');
    eventBus.off('overlay:command', cmd);
  });

  it('fires onPress and onRelease on the edges', async () => {
    const onPress = jest.fn();
    const onRelease = jest.fn();
    let down = false;
    const hk = new GlobalHotkey({
      combo: 'Ctrl+Shift+Space',
      check: async () => down,
      pollMs: 1000,
      onPress,
      onRelease,
    });

    down = true;
    await hk.poll();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();

    // Still held — no repeat press and no release.
    await hk.poll();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();

    down = false;
    await hk.poll();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
