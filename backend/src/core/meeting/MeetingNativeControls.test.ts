import {
  detectNativeMeetingApp,
  nativeShortcut,
  nativeProcessName,
  nativeProcessNames,
} from './MeetingNativeControls';

describe('detectNativeMeetingApp', () => {
  const running = (procs: string[]) => (name: string) => procs.includes(name);

  it('returns null for none/undefined preference', () => {
    expect(detectNativeMeetingApp('none', running([]))).toBeNull();
    expect(detectNativeMeetingApp(undefined, running(['Zoom']))).toBeNull();
  });

  it('returns the pinned app regardless of processes', () => {
    expect(detectNativeMeetingApp('zoom', running([]))).toBe('zoom');
    expect(detectNativeMeetingApp('teams', running([]))).toBe('teams');
  });

  it('auto-detects a running app', () => {
    expect(detectNativeMeetingApp('auto', running(['Zoom']))).toBe('zoom');
    expect(detectNativeMeetingApp('auto', running(['ms-teams']))).toBe('teams');
    expect(detectNativeMeetingApp('auto', running(['chrome']))).toBeNull();
  });

  it('prefers zoom when both are running (checked first)', () => {
    expect(detectNativeMeetingApp('auto', running(['Zoom', 'ms-teams']))).toBe('zoom');
  });
});

describe('nativeShortcut', () => {
  it('maps zoom and teams mute/hand shortcuts', () => {
    expect(nativeShortcut('zoom', 'mute')).toBe('Alt+A');
    expect(nativeShortcut('zoom', 'raiseHand')).toBe('Alt+Y');
    expect(nativeShortcut('teams', 'mute')).toBe('Ctrl+Shift+M');
    expect(nativeShortcut('teams', 'raiseHand')).toBe('Ctrl+Shift+K');
  });

  it('returns null for unreliable shortcuts', () => {
    expect(nativeShortcut('zoom', 'stopShare')).toBeNull();
    expect(nativeShortcut('teams', 'stopShare')).toBe('Ctrl+Shift+E');
  });
});

describe('nativeProcessName(s)', () => {
  it('exposes the focus target and candidates', () => {
    expect(nativeProcessName('zoom')).toBe('Zoom');
    expect(nativeProcessNames('teams')).toEqual(['ms-teams', 'Teams']);
  });
});
