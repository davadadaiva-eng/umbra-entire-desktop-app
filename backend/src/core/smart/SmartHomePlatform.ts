/**
 * SmartHomePlatform — provider-neutral smart home abstraction for Umbra OS.
 *
 * Every platform adapter (SmartThings, Home Assistant, Hubitat, openHAB,
 * Tuya/Smart Life, Hive, Homey, Apple Home, Alexa, Google Home…) implements
 * this one interface, so the agent, scheduler and UI can treat all platforms
 * identically.
 *
 * Device ids are namespaced across platforms as `<platformKey>:<nativeId>`
 * to avoid collisions, and the hub fuzzy-matches names ("turn on the desk
 * lamp") across every connected platform at once.
 */

import type { SwitchCommand } from './SmartThingsService';

/** Normalized device model shared by all platforms and the UI. */
export interface SmartHomeDeviceV2 {
  /** Globally unique: `<platformKey>:<nativeId>`. */
  id: string;
  /** Native id within the platform. */
  nativeId: string;
  platform: string;
  platformLabel: string;
  name: string;
  kind: 'light' | 'switch' | 'plug' | 'sensor' | 'thermostat' | 'lock' | 'camera' | 'speaker' | 'device';
  manufacturer: string;
  room: string;
  switchCapable: boolean;
  switchState: 'on' | 'off' | null;
  online: boolean;
}

/** Result of a control action. */
export interface SmartControlResult {
  ok: boolean;
  deviceId: string;
  name: string;
  command: SwitchCommand;
  platform: string;
}

/** Every platform adapter implements this. */
export interface SmartHomePlatform {
  /** Stable key, e.g. 'smartthings' | 'homeassistant' | 'hubitat' | ... */
  readonly key: string;
  /** Human label shown in the UI. */
  readonly label: string;
  /** Connect help shown in the UI card. */
  readonly help: string;
  /** URL to obtain credentials, if applicable. */
  readonly credentialsUrl?: string;
  /** Whether credentials are configured (token/url/...). */
  isConfigured(): boolean;
  /** Persist a credential (token adapters). Validate by listing devices first. `url` is the server URL for self-hosted platforms. */
  setToken?(token: string, url?: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }>;
  clearToken?(): Promise<void>;
  getMaskedToken?(): string;
  /** Vendor offers an OAuth app (cloud platforms only). */
  getOAuthProvider?(): { name: string; requiresClientApp?: boolean } | undefined;
  /** An OAuth app is registered, so "Sign in with …" will actually work. */
  supportsOAuth?(): boolean;
  /** Start an OAuth flow — returns the consent URL to open in a browser. */
  beginOAuth?(redirectUri: string): { authorizeUrl: string; state: string };
  /** Finish an OAuth flow with the callback code + state. */
  completeOAuth?(code: string, state: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }>;
  /** List + normalize devices. `withStates` enriches on/off state where supported. */
  getDevices(opts?: { withStates?: boolean }): Promise<SmartHomeDeviceV2[]>;
  /** Send a switch command to a native device id. */
  sendCommand(nativeId: string, command: SwitchCommand): Promise<void>;
  /** Human message for the last fatal error (401/403 etc.), if any. */
  lastError?: string;
}

/** Catalog entry used by the UI to render connect cards. */
export interface PlatformCatalogEntry {
  key: string;
  label: string;
  help: string;
  credentialsUrl?: string;
  configured: boolean;
  connected: boolean;
  tokenMasked?: string;
  lastError?: string;
  /**
   * 'oauth' when the vendor offers a real sign-in flow (cloud platforms),
   * 'token' when the user must paste a long-lived token. Self-hosted platforms
   * are permanently 'token' — that is the only mechanism those ecosystems offer.
   */
  authMode: 'oauth' | 'token';
  /** Button label for the sign-in flow, e.g. "Sign in with Samsung SmartThings". */
  oauthLabel?: string;
  /** An OAuth app is registered and the sign-in flow will work. */
  oauthConfigured: boolean;
  /** The platform cannot connect at all without a registered OAuth app. */
  requiresClientApp: boolean;
}

/**
 * Unified hub — instantiates every supported adapter once and fans
 * device/control calls out to all configured platforms. One failing
 * platform never sinks the aggregate response.
 */
export class SmartHomeHub {
  private platforms: SmartHomePlatform[] = [];

  register(p: SmartHomePlatform): void {
    this.platforms.push(p);
  }

  /** All catalog entries (for the UI connect cards). */
  catalog(): PlatformCatalogEntry[] {
    return this.platforms.map((p) => {
      const oauth = p.getOAuthProvider?.();
      const oauthConfigured = p.supportsOAuth?.() ?? false;
      return {
        key: p.key,
        label: p.label,
        help: p.help,
        credentialsUrl: p.credentialsUrl,
        configured: p.isConfigured(),
        connected: p.isConfigured(),
        tokenMasked: p.getMaskedToken?.(),
        lastError: p.lastError,
        authMode: oauth ? 'oauth' : 'token',
        oauthLabel: oauth ? `Sign in with ${oauth.name}` : undefined,
        oauthConfigured,
        requiresClientApp: oauth?.requiresClientApp ?? false,
      };
    });
  }

  /** Platform adapters that have credentials configured. */
  active(): SmartHomePlatform[] {
    return this.platforms.filter((p) => p.isConfigured());
  }

  get(key: string): SmartHomePlatform | undefined {
    return this.platforms.find((p) => p.key === key);
  }

  /** Aggregate devices from every configured platform. One failing platform doesn't sink the rest. */
  async getDevices(opts?: { withStates?: boolean; platform?: string }): Promise<SmartHomeDeviceV2[]> {
    const targets = opts?.platform
      ? this.active().filter((p) => p.key === opts.platform)
      : this.active();
    const results = await Promise.allSettled(
      targets.map(async (p) => {
        try {
          return await p.getDevices(opts);
        } catch (e) {
          p.lastError = (e as Error).message;
          throw e;
        }
      }),
    );
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }

  /** Send a command to a namespaced id (`<platformKey>:<nativeId>`). */
  async sendCommand(nsId: string, command: SwitchCommand): Promise<SmartControlResult> {
    const idx = nsId.indexOf(':');
    const key = idx > 0 ? nsId.slice(0, idx) : '';
    const nativeId = idx > 0 ? nsId.slice(idx + 1) : nsId;
    const platform = this.platforms.find((p) => p.key === key);
    if (!platform || !platform.isConfigured()) throw new Error(`No connected smart home platform "${key || 'unknown'}"`);
    await platform.sendCommand(nativeId, command);
    return { ok: true, deviceId: nsId, name: '', command, platform: key };
  }

  /** Control across ALL configured platforms by fuzzy name (agent-facing). */
  async controlByName(name: string, command: SwitchCommand): Promise<SmartControlResult> {
    const q = name.trim().toLowerCase();
    if (!q) throw new Error('device name is required');
    const devices = await this.getDevices({ withStates: true });
    const scored = devices
      .map((d) => ({ d, score: fuzzyScore(q, d.name.toLowerCase()) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      throw new Error(`No device matching "${name}" on any connected platform`);
    }
    const best = scored[0].d;
    await this.sendCommand(best.id, command);
    return { ok: true, deviceId: best.id, name: best.name, command, platform: best.platform };
  }
}

/** Simple token-overlap fuzzy scorer used for cross-platform name matching. */
export function fuzzyScore(query: string, label: string): number {
  if (!query || !label) return 0;
  if (label === query) return 100;
  if (label.includes(query)) return 80;
  const tokens = query.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  const score = tokens.reduce((acc, t) => acc + (label.includes(t) ? 1 : 0), 0);
  return score > 0 ? 10 + score : 0;
}
