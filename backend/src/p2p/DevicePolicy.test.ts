import { maxDevicesForTier, assertCanJoinDevice, deviceLimitLabel } from './DevicePolicy';

describe('DevicePolicy', () => {
  describe('maxDevicesForTier', () => {
    it('allows exactly 1 device on free / byok / pro', () => {
      expect(maxDevicesForTier('free')).toBe(1);
      expect(maxDevicesForTier('byok')).toBe(1);
      expect(maxDevicesForTier('pro')).toBe(1);
    });

    it('allows 5 devices on ultimate/advanced', () => {
      expect(maxDevicesForTier('ultimate')).toBe(5);
      expect(maxDevicesForTier('advanced')).toBe(5);
    });

    it('allows unlimited devices on enterprise', () => {
      expect(maxDevicesForTier('enterprise')).toBe('unlimited');
    });

    it('defaults unknown tiers to 1 (fail-closed)', () => {
      expect(maxDevicesForTier('whatever')).toBe(1);
    });
  });

  describe('assertCanJoinDevice', () => {
    it('lets the first device join on a 1-device plan', () => {
      expect(() => assertCanJoinDevice('pro', 0)).not.toThrow();
    });

    it('blocks a second device on pro with an actionable message', () => {
      expect(() => assertCanJoinDevice('pro', 1)).toThrow(/at most 1 connected device/);
      expect(() => assertCanJoinDevice('pro', 1)).toThrow(/revoke an existing device/i);
      expect(() => assertCanJoinDevice('pro', 1)).toThrow(/enterprise/i);
    });

    it('lets up to 5 devices join on ultimate', () => {
      expect(() => assertCanJoinDevice('ultimate', 0)).not.toThrow();
      expect(() => assertCanJoinDevice('ultimate', 4)).not.toThrow();
    });

    it('blocks a 6th device on ultimate', () => {
      expect(() => assertCanJoinDevice('ultimate', 5)).toThrow(/at most 5 connected devices/);
    });

    it('never blocks on enterprise', () => {
      expect(() => assertCanJoinDevice('enterprise', 0)).not.toThrow();
      expect(() => assertCanJoinDevice('enterprise', 5)).not.toThrow();
      expect(() => assertCanJoinDevice('enterprise', 1000)).not.toThrow();
    });
  });

  describe('deviceLimitLabel', () => {
    it('returns correct labels per tier', () => {
      expect(deviceLimitLabel('pro')).toBe(1);
      expect(deviceLimitLabel('ultimate')).toBe(5);
      expect(deviceLimitLabel('enterprise')).toBe('unlimited');
    });
  });
});
