import { LiveShadowEngine } from './LiveShadowEngine';

describe('LiveShadowEngine', () => {
  it('grants takeovers and enforces expiration', () => {
    const shadow = new LiveShadowEngine();
    const grant = shadow.requestTakeover({ reason: 'help user', durationMs: 1000 });
    expect(grant.granted).toBe(true);
    expect(grant.token).toBeDefined();
    expect(shadow.isTakeoverActive(grant.token)).toBe(true);

    const denied = shadow.requestTakeover({ reason: 'again', durationMs: 1000 });
    expect(denied.granted).toBe(false);
    expect(denied.reason).toMatch(/active/);

    shadow.releaseTakeover(grant.token!);
    expect(shadow.isTakeoverActive(grant.token)).toBe(false);
  });

  it('releases takeover on token match only', () => {
    const shadow = new LiveShadowEngine();
    const grant = shadow.requestTakeover({ reason: 'x', durationMs: 10000 });
    expect(shadow.releaseTakeover('wrong-token')).toBe(false);
    expect(shadow.releaseTakeover(grant.token!)).toBe(true);
  });

  it('start/stop lifecycle is idempotent', () => {
    const shadow = new LiveShadowEngine({ captureIntervalMs: 5000 });
    shadow.start();
    shadow.start();
    expect(shadow.isRunning).toBe(true);
    shadow.stop();
    shadow.stop();
    expect(shadow.isRunning).toBe(false);
  });
});
