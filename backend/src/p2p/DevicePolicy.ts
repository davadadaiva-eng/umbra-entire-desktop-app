/**
 * How many devices a plan tier may register in the cloud device mesh.
 *   - free / byok     → 1 device (the phone OR the desktop, not both)
 *   - pro             → 1 device
 *   - ultimate        → 5 devices
 *   - enterprise      → unlimited (a multi-device family/org plan)
 *
 * The limit is enforced at join time (`DeviceRegistry.redeemInvite` path) —
 * already-registered devices keep reconnecting with their persisted tokens.
 * Replacing a device means revoking the old one first.
 */
export function maxDevicesForTier(tier: string): number | 'unlimited' {
  if (tier === 'enterprise') return 'unlimited';
  if (tier === 'ultimate' || tier === 'advanced') return 5;
  return 1;
}

/**
 * Throw if the current device count already fills the tier's allowance.
 * Call before registering a new device so the user gets a clear, actionable
 * error instead of a silently accepted join.
 */
export function assertCanJoinDevice(tier: string, currentCount: number): void {
  const limit = maxDevicesForTier(tier);
  if (limit !== 'unlimited' && currentCount >= limit) {
    throw new Error(
      `Plan ${tier} allows at most ${limit} connected device${limit === 1 ? '' : 's'} (currently ${currentCount}). ` +
      `Revoke an existing device first, or upgrade to Enterprise for unlimited devices.`,
    );
  }
}

/** Serialize the allowance for API responses ('unlimited' stays a string). */
export function deviceLimitLabel(tier: string): number | 'unlimited' {
  return maxDevicesForTier(tier);
}
