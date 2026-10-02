/**
 * GoogleSdmAdapter — Google Home via the official Smart Device Management API.
 *
 * ── Scope, stated plainly ──────────────────────────────────────────────
 * SDM only exposes **Google's own devices**: Nest/Google thermostats,
 * cameras, doorbells and displays. It does NOT reach third-party lights and
 * switches that merely sit in your Google Home account — those are controlled
 * through their own vendors' clouds, and no Google API will hand them over.
 * Anyone expecting their Hue bulbs to show up here will not get them.
 *
 * There is also no personal access token for SDM: OAuth is the only way in.
 * That makes this adapter OAuth-only, unlike SmartThings which accepts either.
 *
 * API shape (https://smartdevicemanagement.googleapis.com/v1):
 *   GET  /enterprises/{projectId}/devices
 *   GET  /enterprises/{projectId}/structures
 *   GET  /enterprises/{projectId}/structures/{id}/rooms
 *   POST /enterprises/{projectId}/devices/{id}:executeCommand
 *
 * Devices are returned with a bag of `traits`; each trait is only present if
 * the device supports it, so every read here is defensive.
 */

import { getLogger } from '../Logger';
import type { SwitchCommand } from './SmartThingsService';
import { SMART_HOME_OAUTH } from './SmartHomeOAuth';
import { TokenPlatformAdapter } from './TokenPlatformAdapter';
import type { SmartHomeDeviceV2 } from './SmartHomePlatform';

const SDM_HOST = 'https://smartdevicemanagement.googleapis.com/v1';

/** A trait bag as returned by SDM: keys are fully-qualified trait names. */
type Traits = Record<string, Record<string, unknown>>;

interface SdmDevice {
  /** `devices/abc123` */
  name: string;
  /** e.g. `sdm.devices.types.THERMOSTAT` */
  type: string;
  traits?: Traits;
  parentRelations?: Array<{ parent?: string; room?: string; displayName?: string }>;
}

interface SdmList<T> {
  devices?: T[];
  structures?: T[];
  rooms?: T[];
}

interface SdmNamed {
  name: string;
  traits?: Traits;
}

/** Room/structure display names change rarely; cache briefly to avoid N calls. */
const ROOM_CACHE_MS = 5 * 60_000;

/** Which non-OFF mode to restore when a thermostat is switched back on. */
const DEFAULT_RESTORE_MODE = 'HEAT';

export class GoogleSdmAdapter extends TokenPlatformAdapter {
  readonly key = 'googlehome';
  readonly label = 'Google Home';
  readonly help = 'Sign in with Google to control Nest thermostats, cameras, doorbells and displays. Third-party lights and switches are not exposed by Google\'s API.';
  readonly credentialsUrl = 'https://console.cloud.google.com/apis/credentials';
  /** Cloud platform — OAuth only; there is no personal access token for SDM. */
  protected override oauth = SMART_HOME_OAUTH['google'];
  /** The registry calls this provider `google`; the platform key is `googlehome`. */
  protected override oauthKey = 'google';

  private roomCache?: { at: number; byId: Map<string, string> };

  constructor(vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0]) {
    super(vault, 'googlehome');
    this.baseUrl = `${SDM_HOST}/enterprises/${encodeURIComponent(this.projectId() || '{project-id}')}`;
  }

  /**
   * The Device Access project id that owns the authorized devices.
   *
   * SDM scopes resources under `/enterprises/{projectId}` where the id is the
   * *numeric* project number from the Device Access console — not the project
   * name — so this is a separate setting from any GCP project name.
   */
  private projectId(): string {
    return (process.env['UMBRA_GOOGLE_PROJECT_ID'] || process.env['GOOGLE_CLOUD_PROJECT'] || '').trim();
  }

  /** SDM has no PAT — fail loudly instead of pretending a pasted token works. */
  override async setToken(_token: string, _url?: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }> {
    throw new Error(
      'Google Home has no personal access token — use "Sign in with Google Home" to link your account instead.',
    );
  }

  private requireProjectId(): string {
    const id = this.projectId();
    if (!id) {
      throw new Error(
        'No Google Device Access project configured — set UMBRA_GOOGLE_PROJECT_ID in backend/.env ' +
        'to the numeric project id shown in the Device Access console.',
      );
    }
    return id;
  }

  async getDevices(opts?: { withStates?: boolean }): Promise<SmartHomeDeviceV2[]> {
    this.requireProjectId();
    const page = await this.request<SdmList<SdmDevice>>('GET', `${this.baseUrl}/devices`, {
      headers: { Authorization: await this.authHeader() },
    });
    const rooms = await this.roomNames().catch(() => new Map<string, string>());
    const devices = (page.devices || []).map((d) => this.normalize(d, rooms));
    if (opts?.withStates) {
      // SDM returns the full trait bag on every list, so state is already in
      // hand — there is no extra round trip to make here.
      getLogger().debug({ platform: this.key, count: devices.length }, 'Google SDM: devices listed');
    }
    return devices;
  }

  /**
   * SDM's only power-like control is the thermostat mode, so on/off maps to
   * OFF / restore-last-mode. Other device types (cameras, doorbells,
   * displays) have no on/off concept and are rejected with an explanation
   * rather than a vendor error.
   */
  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    this.requireProjectId();
    const device = await this.getDevice(nativeId);
    const type = device?.type || '';
    if (!type.endsWith('THERMOSTAT')) {
      const kind = type.replace('sdm.devices.types.', '').toLowerCase() || 'this device';
      throw new Error(
        `Google's API has no on/off command for ${kind} devices — it only exposes thermostat mode. ` +
        'Use the vendor app, or link that device through Home Assistant instead.',
      );
    }
    const traits = device?.traits || {};
    const mode = traits['sdm.devices.traits.ThermostatMode']?.['mode'];
    const available = (traits['sdm.devices.traits.ThermostatMode']?.['availableModes'] as string[] | undefined) || [];

    if (command === 'off') {
      await this.executeCommand(nativeId, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: 'OFF' });
      return;
    }
    // Turning back on: keep whatever the user had before we switched it off.
    const restore = this.lastActiveMode(mode, available);
    await this.executeCommand(nativeId, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: restore });
  }

  /**
   * Prefer the current mode if it is not OFF; otherwise fall back to a mode
   * the thermostat actually advertises, so we never command an invalid one.
   */
  private lastActiveMode(current: unknown, available: string[]): string {
    if (typeof current === 'string' && current !== 'OFF') return current;
    if (available.includes(DEFAULT_RESTORE_MODE)) return DEFAULT_RESTORE_MODE;
    return available.find((m) => m !== 'OFF') || DEFAULT_RESTORE_MODE;
  }

  /** Fetch one device so we can read its traits before commanding it. */
  private async getDevice(nativeId: string): Promise<SdmDevice | undefined> {
    const path = nativeId.startsWith('devices/') ? nativeId : `devices/${nativeId}`;
    try {
      return await this.request<SdmDevice>('GET', `${this.baseUrl}/${path}`, {
        headers: { Authorization: await this.authHeader() },
      });
    } catch {
      return undefined;
    }
  }

  private async executeCommand(nativeId: string, command: string, params: Record<string, unknown>): Promise<void> {
    const path = nativeId.startsWith('devices/') ? nativeId : `devices/${nativeId}`;
    await this.request('POST', `${this.baseUrl}/${path}:executeCommand`, {
      headers: { Authorization: await this.authHeader(), 'Content-Type': 'application/json' },
      body: { command, params },
    });
    getLogger().info({ platform: this.key, device: path, command }, 'Google SDM: command sent');
  }

  /**
   * Resolve `rooms/xyz` and `structures/abc` resource ids to display names so
   * devices land in the right room in the UI. Best-effort: a failure here only
   * costs us the room name, never the device.
   */
  private async roomNames(): Promise<Map<string, string>> {
    if (this.roomCache && Date.now() - this.roomCache.at < ROOM_CACHE_MS) return this.roomCache.byId;
    const byId = new Map<string, string>();
    const auth = { Authorization: await this.authHeader() };
    const structures = await this.request<SdmList<SdmNamed>>('GET', `${this.baseUrl}/structures`, { headers: auth });
    for (const s of structures.structures || []) {
      const label = this.traitName(s);
      if (label) byId.set(s.name, label);
      const rooms = await this.request<SdmList<SdmNamed>>('GET', `${this.baseUrl}/${s.name}/rooms`, { headers: auth })
        .catch(() => ({}) as SdmList<SdmNamed>);
      for (const r of rooms.rooms || []) {
        const roomLabel = this.traitName(r);
        if (roomLabel) byId.set(r.name, roomLabel);
      }
    }
    this.roomCache = { at: Date.now(), byId };
    return byId;
  }

  private traitName(resource: SdmNamed): string {
    return String(resource?.traits?.['sdm.devices.traits.Info']?.['customName'] || '');
  }

  private normalize(device: SdmDevice, rooms: Map<string, string>): SmartHomeDeviceV2 {
    const traits = device.traits || {};
    const nativeId = device.name.replace(/^devices\//, '');
    const mode = traits['sdm.devices.traits.ThermostatMode']?.['mode'];
    const isThermostat = (device.type || '').endsWith('THERMOSTAT');
    const parent = device.parentRelations?.[0];
    const roomKey = parent?.room || parent?.parent || '';

    return {
      id: `googlehome:${nativeId}`,
      nativeId,
      platform: this.key,
      platformLabel: this.label,
      name: this.traitName(device) || `Google ${nativeId.slice(0, 8)}`,
      kind: this.kindFromType(device.type || ''),
      manufacturer: 'Google',
      room: rooms.get(roomKey) || parent?.displayName || 'Unassigned',
      // Only thermostats have anything an on/off control can act on.
      switchCapable: isThermostat,
      switchState: isThermostat ? (mode === 'OFF' ? 'off' : 'on') : null,
      online: traits['sdm.devices.traits.Connectivity']?.['status'] !== 'OFFLINE',
    };
  }

  private kindFromType(type: string): SmartHomeDeviceV2['kind'] {
    const t = type.replace('sdm.devices.types.', '').toLowerCase();
    if (t.includes('thermostat')) return 'thermostat';
    if (t.includes('camera') || t.includes('doorbell')) return 'camera';
    if (t.includes('display')) return 'device';
    return 'device';
  }
}