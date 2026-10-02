/**
 * SmartHomeAdapters — one adapter per smart home platform for Umbra OS.
 *
 * Token-based (paste a PAT / API key in the UI and go):
 *   smartthings   — Samsung SmartThings PAT        account.smartthings.com/tokens
 *   hubitat       — Hubitat Elevation Maker API    hubitat.com → Apps → Maker API
 *   openhab       — openHAB REST API token         openHAB console / main UI
 *   tuya          — Tuya IoT / Smart Life          iot.tuya.com cloud project
 *   hive          — British Gas Hive               api.bgchprod.info OAuth
 *   homey         — Athom Homey                    developer.athom.com PAT
 *   homeassistant — Home Assistant long-lived token  <url>/profile → security
 *
 * Local hubs that need no cloud token (URL only, optional password):
 *   homeassistant works with a local long-lived token; applehome/alexactl/
 *   googlehome are wired as bridge adapters that shell out to the official
 *   CLIs when installed (`athome`, `alex-remote-control`, `glocal`).
 *
 * Every adapter implements SmartHomePlatform so the hub treats them all
 * identically; device ids are namespaced as `<key>:<nativeId>` upstream.
 */

import { getLogger } from '../Logger';
import type { SwitchCommand } from './SmartThingsService';
import type { SmartHomePlatform, SmartHomeDeviceV2 } from './SmartHomePlatform';
import { GoogleSdmAdapter } from './GoogleSdmAdapter';
import { SMART_HOME_OAUTH } from './SmartHomeOAuth';
import { TokenPlatformAdapter } from './TokenPlatformAdapter';
// Re-exported so existing importers (and the type position
// `ConstructorParameters<typeof TokenPlatformAdapter>`) keep working.
export { TokenPlatformAdapter };


// ── SmartThings ──────────────────────────────────────────────────

interface StDevice {
  deviceId: string;
  label?: string;
  name?: string;
  manufacturerName?: string;
  roomId?: string;
  components: Array<{ id: string; capabilities: Array<{ id: string }> }>;
}

export class SmartThingsAdapter extends TokenPlatformAdapter {
  readonly key = 'smartthings';
  readonly label = 'Samsung SmartThings';
  readonly help = 'Create a personal access token with Devices (Read + Control) and Rooms (Read) scopes.';
  readonly credentialsUrl = 'https://account.smartthings.com/tokens';
  /** Cloud platform — supports "Sign in with SmartThings" when an OAuth app is registered. */
  protected override oauth = SMART_HOME_OAUTH['smartthings'];

  constructor(vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0]) {
    super(vault, 'smartthings');
    this.baseUrl = (process.env['UMBRA_SMARTTHINGS_URL'] || 'https://api.smartthings.com').replace(/\/+$/, '');
  }

  async setToken(token: string, url?: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }> {
    if (url?.trim()) this.baseUrl = url.trim().replace(/\/+$/, '');
    return super.setToken(token);
  }

  async getDevices(opts?: { withStates?: boolean }): Promise<SmartHomeDeviceV2[]> {
    const page = await this.request<{ items?: StDevice[] }>('GET', `${this.baseUrl}/v1/devices?max=200`, {
      headers: { Authorization: await this.authHeader() },
    });
    const devices = (page.items || []).map((d) => this.normalize(d));
    if (opts?.withStates) {
      const capable = devices.filter((d) => d.switchCapable);
      const states = await Promise.allSettled(
        capable.map((d) => this.getSwitchState(d.nativeId)),
      );
      states.forEach((s, i) => {
        if (s.status === 'fulfilled') capable[i].switchState = s.value;
      });
    }
    return devices;
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.request('POST', `${this.baseUrl}/v1/devices/${encodeURIComponent(nativeId)}/commands`, {
      headers: { Authorization: await this.authHeader(), 'Content-Type': 'application/json' },
      body: { commands: [{ component: 'main', capability: 'switch', command, arguments: [] }] },
    });
    getLogger().info({ platform: this.key, nativeId, command }, 'SmartThingsAdapter: command sent');
  }

  private normalize(d: StDevice): SmartHomeDeviceV2 {
    const caps = d.components.flatMap((c) => c.capabilities.map((x) => x.id));
    const label = (d.label || d.name || d.deviceId).toLowerCase();
    const kind: SmartHomeDeviceV2['kind'] =
      caps.includes('colorControl') || (caps.includes('switch') && caps.includes('switchLevel') && label.includes('light')) ? 'light' :
      caps.includes('switchLevel') ? 'switch' :
      caps.includes('outlet') || caps.includes('relaySwitch') ? 'plug' :
      caps.includes('switch') ? 'switch' :
      caps.includes('thermostat') || caps.includes('airConditionerMode') || caps.includes('temperatureMeasurement') ? 'thermostat' :
      caps.includes('lock') ? 'lock' :
      caps.includes('motionSensor') || caps.includes('contactSensor') || caps.includes('presenceSensor') || caps.includes('waterSensor') || caps.includes('smokeDetector') ? 'sensor' :
      'device';
    return {
      id: `smartthings:${d.deviceId}`,
      nativeId: d.deviceId,
      platform: this.key,
      platformLabel: this.label,
      name: d.label || d.name || d.deviceId,
      kind,
      manufacturer: d.manufacturerName || 'Unknown',
      room: 'Unassigned',
      switchCapable: caps.includes('switch'),
      switchState: null,
      online: true,
    };
  }

  private async getSwitchState(nativeId: string): Promise<'on' | 'off' | null> {
    try {
      const st = await this.request<{ switch?: { value?: unknown } }>(
        'GET',
        `${this.baseUrl}/v1/devices/${encodeURIComponent(nativeId)}/components/main/status`,
        { headers: { Authorization: await this.authHeader() } },
      );
      const v = st?.switch?.value;
      if (v === 'on' || v === true) return 'on';
      if (v === 'off' || v === false) return 'off';
      return null;
    } catch {
      return null;
    }
  }
}

// ── Hubitat Elevation (Maker API) ────────────────────────────────

interface HubitatDevice {
  id: string;
  label: string;
  name?: string;
  type?: string;
  room?: string;
}

export class HubitatAdapter extends TokenPlatformAdapter {
  readonly key = 'hubitat';
  readonly label = 'Hubitat Elevation';
  readonly help = 'Create a Maker API app on the hub, allow its access token, and paste the hub URL + token below.';
  private hubUrl = '';

  constructor(
    private config: { hubUrl?: string; token?: string } = {},
    vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0],
  ) {
    super(vault, 'hubitat');
    this.hubUrl = (config.hubUrl || process.env['UMBRA_HUBITAT_URL'] || '').replace(/\/+$/, '');
    if (!this.token && config.token) this.token = config.token;
  }

  isConfigured(): boolean {
    return Boolean(this.hubUrl && this.token);
  }

  async setToken(token: string, url?: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }> {
    if (url?.trim()) this.hubUrl = url.trim().replace(/\/+$/, '');
    return super.setToken(token);
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const res = await this.request<HubitatDevice[] | { devices?: HubitatDevice[] }>(
      'GET',
      `${this.hubUrl}/apps/api/${this.makerAppId()}/devices?access_token=${encodeURIComponent(this.token)}`,
    );
    const items = Array.isArray(res) ? res : (res.devices || []);
    return items.map((d) => ({
      id: `hubitat:${d.id}`,
      nativeId: String(d.id),
      platform: this.key,
      platformLabel: this.label,
      name: d.label || d.name || d.id,
      kind: this.kindFromType(d.type || ''),
      manufacturer: 'Hubitat',
      room: d.room || 'Unassigned',
      switchCapable: true, // Maker API exposes on/off for nearly all controllables
      switchState: null,
      online: true,
    }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.request(
      'GET',
      `${this.hubUrl}/apps/api/${this.makerAppId()}/devices/${encodeURIComponent(nativeId)}/${command}?access_token=${encodeURIComponent(this.token)}`,
    );
    getLogger().info({ platform: this.key, nativeId, command }, 'HubitatAdapter: command sent');
  }

  private makerAppId(): string {
    return process.env['UMBRA_HUBITAT_APP_ID'] || '1';
  }

  private kindFromType(type: string): SmartHomeDeviceV2['kind'] {
    const t = type.toLowerCase();
    if (t.includes('light') || t.includes('bulb')) return 'light';
    if (t.includes('outlet') || t.includes('plug')) return 'plug';
    if (t.includes('thermostat')) return 'thermostat';
    if (t.includes('lock')) return 'lock';
    if (t.includes('sensor')) return 'sensor';
    if (t.includes('switch') || t.includes('dimmer')) return 'switch';
    return 'device';
  }
}

// ── openHAB (REST API) ───────────────────────────────────────────

interface OpenhabItem {
  name: string;
  label?: string;
  type: string;
  metadata?: Record<string, unknown>;
  groupNames?: string[];
}

export class OpenhabAdapter extends TokenPlatformAdapter {
  readonly key = 'openhab';
  readonly label = 'openHAB';
  readonly help = 'Enable REST API auth (token or basic auth) and paste the openHAB server URL + token.';
  private readonly urlEnv = 'UMBRA_OPENHAB_URL';

  constructor(
    private config: { url?: string; token?: string } = {},
    vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0],
  ) {
    super(vault, 'openhab');
    this.baseUrl = (config.url || process.env[this.urlEnv] || '').replace(/\/+$/, '');
    if (!this.token && config.token) this.token = config.token;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const items = await this.request<OpenhabItem[]>(
      'GET',
      `${this.baseUrl}/rest/items?tags=Switchable`,
      await this.auth(),
    );
    return (items || [])
      .filter((i) => i.type === 'Switch' || i.type === 'Dimmer' || i.type === 'Group')
      .map((i) => ({
        id: `openhab:${i.name}`,
        nativeId: i.name,
        platform: this.key,
        platformLabel: this.label,
        name: i.label || i.name,
        kind: i.type === 'Dimmer' ? 'light' : 'switch',
        manufacturer: 'openHAB',
        room: i.groupNames?.[0] || 'Unassigned',
        switchCapable: i.type === 'Switch' || i.type === 'Dimmer' || i.type === 'Group',
        switchState: null,
        online: true,
      }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.request('POST', `${this.baseUrl}/rest/items/${encodeURIComponent(nativeId)}`, {
      headers: { ...(await this.auth()).headers, 'Content-Type': 'text/plain' },
      body: command === 'on' ? 'ON' : 'OFF',
    });
    getLogger().info({ platform: this.key, nativeId, command }, 'OpenhabAdapter: command sent');
  }

  private async auth(): Promise<{ headers: Record<string, string> }> {
    const headers: Record<string, string> = {};
    const auth = await this.authHeader();
    if (auth) headers.Authorization = auth;
    return { headers };
  }
}

// ── Tuya / Smart Life (IoT cloud) ────────────────────────────────

interface TuyaDevice {
  id: string;
  name?: string;
  model?: string;
  category?: string;
  online?: boolean;
}

/**
 * Tuya IoT cloud adapter. Needs an IoT project with a clientId/clientSecret
 * pair; the token below is the project access token (auto-refreshed by the
 * vendor SDK — here we keep it simple and use the /v1.0/token handshake).
 */
export class TuyaAdapter extends TokenPlatformAdapter {
  readonly key = 'tuya';
  readonly label = 'Tuya / Smart Life';
  readonly help = 'Create a Tuya IoT cloud project and paste the access token + API endpoint (e.g. https://openapi.tuyaus.com).';
  private apiBase = '';

  constructor(
    private config: { endpoint?: string; token?: string } = {},
    vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0],
  ) {
    super(vault, 'tuya');
    this.apiBase = (config.endpoint || process.env['UMBRA_TUYA_ENDPOINT'] || 'https://openapi.tuyaus.com').replace(/\/+$/, '');
    if (!this.token && config.token) this.token = config.token;
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.apiBase);
  }

  async setToken(token: string, url?: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }> {
    if (url?.trim()) this.apiBase = url.trim().replace(/\/+$/, '');
    return super.setToken(token);
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const res = await this.request<{ result?: { list?: TuyaDevice[] } }>(
      'GET',
      `${this.apiBase}/v1.0/devices`,
      { headers: { Authorization: await this.authHeader() } },
    );
    return (res.result?.list || []).map((d) => ({
      id: `tuya:${d.id}`,
      nativeId: d.id,
      platform: this.key,
      platformLabel: this.label,
      name: d.name || d.id,
      kind: this.kindFromCategory(d.category || ''),
      manufacturer: 'Tuya',
      room: 'Unassigned',
      switchCapable: true,
      switchState: null,
      online: d.online !== false,
    }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.request('POST', `${this.apiBase}/v1.0/devices/${encodeURIComponent(nativeId)}/commands`, {
      headers: { Authorization: await this.authHeader(), 'Content-Type': 'application/json' },
      body: { commands: [{ code: 'switch_1', value: command === 'on' }] },
    });
    getLogger().info({ platform: this.key, nativeId, command }, 'TuyaAdapter: command sent');
  }

  private kindFromCategory(cat: string): SmartHomeDeviceV2['kind'] {
    const c = cat.toLowerCase();
    if (c.includes('light') || c.includes('dj')) return 'light';
    if (c.includes('cz') || c.includes('socket')) return 'plug';
    if (c.includes('kg') || c.includes('switch')) return 'switch';
    if (c.includes('sensor')) return 'sensor';
    if (c.includes('lock')) return 'lock';
    if (c.includes('thermostat') || c.includes('airconditioner')) return 'thermostat';
    return 'device';
  }
}

// ── Hive (British Gas) ───────────────────────────────────────────

export class HiveAdapter extends TokenPlatformAdapter {
  readonly key = 'hive';
  readonly label = 'Hive (British Gas)';
  readonly help = 'Log in to the Hive app/API — paste the OAuth session token from api.bgchprod.info.';
  private readonly hiveBase = 'https://api.bgchprod.info/omnia';

  constructor(
    private config: { token?: string } = {},
    vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0],
  ) {
    super(vault, 'hive');
    if (!this.token && config.token) this.token = config.token;
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const res = await this.request<{ nodes?: Array<{ id: string; name: string; type: string; attributes?: Record<string, { value?: unknown }> }> }>(
      'GET',
      `${this.hiveBase}/nodes`,
      { headers: { Authorization: await this.authHeader() } },
    );
    return (res.nodes || []).map((n) => ({
      id: `hive:${n.id}`,
      nativeId: n.id,
      platform: this.key,
      platformLabel: this.label,
      name: n.name || n.id,
      kind: this.kindFromType(n.type || ''),
      manufacturer: 'Hive',
      room: 'Unassigned',
      switchCapable: Boolean(n.attributes?.['state'] || n.type?.toLowerCase().includes('plug') || n.type?.toLowerCase().includes('light')),
      switchState: (n.attributes?.['state']?.value === 'ON' ? 'on' : n.attributes?.['state']?.value === 'OFF' ? 'off' : null),
      online: true,
    }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.request('PUT', `${this.hiveBase}/nodes/${encodeURIComponent(nativeId)}`, {
      headers: { Authorization: await this.authHeader(), 'Content-Type': 'application/json' },
      body: { nodes: [{ attributes: { state: { targetValue: command.toUpperCase() } } }] },
    });
    getLogger().info({ platform: this.key, nativeId, command }, 'HiveAdapter: command sent');
  }

  private kindFromType(type: string): SmartHomeDeviceV2['kind'] {
    const t = type.toLowerCase();
    if (t.includes('light')) return 'light';
    if (t.includes('plug')) return 'plug';
    if (t.includes('thermostat') || t.includes('heating')) return 'thermostat';
    if (t.includes('sensor')) return 'sensor';
    if (t.includes('lock')) return 'lock';
    return 'device';
  }
}

// ── Homey (Athom) ────────────────────────────────────────────────

export class HomeyAdapter extends TokenPlatformAdapter {
  readonly key = 'homey';
  readonly label = 'Homey (Athom)';
  readonly help = 'Create a Personal Access Token at developer.athom.com and paste it below.';
  readonly credentialsUrl = 'https://tools.developer.homey.app/api-keys';
  private readonly homeyBase = 'https://api.athom.com';

  constructor(
    private config: { token?: string } = {},
    vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0],
  ) {
    super(vault, 'homey');
    if (!this.token && config.token) this.token = config.token;
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const devices = await this.request<Array<{ _id: string; name: string; class?: string; zone?: string; capabilities?: string[]; capabilitiesObj?: Record<string, { value?: unknown }> }>>(
      'GET',
      `${this.homeyBase}/orm/manager/devices/device`,
      { headers: { Authorization: await this.authHeader() } },
    );
    return (devices || []).map((d) => ({
      id: `homey:${d._id}`,
      nativeId: d._id,
      platform: this.key,
      platformLabel: this.label,
      name: d.name || d._id,
      kind: this.kindFromClass(d.class || ''),
      manufacturer: 'Homey',
      room: d.zone || 'Unassigned',
      switchCapable: Boolean(d.capabilities?.includes('onoff')),
      switchState: (d.capabilitiesObj?.onoff?.value === true ? 'on' : d.capabilitiesObj?.onoff?.value === false ? 'off' : null),
      online: true,
    }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.request('PUT', `${this.homeyBase}/device/${encodeURIComponent(nativeId)}/capability/onoff`, {
      headers: { Authorization: await this.authHeader(), 'Content-Type': 'application/json' },
      body: { value: command === 'on' },
    });
    getLogger().info({ platform: this.key, nativeId, command }, 'HomeyAdapter: command sent');
  }

  private kindFromClass(cls: string): SmartHomeDeviceV2['kind'] {
    const c = cls.toLowerCase();
    if (c.includes('light') || c === 'socket' || c === 'doorbell') return 'light';
    if (c === 'socket') return 'plug';
    if (c.includes('thermostat')) return 'thermostat';
    if (c.includes('lock')) return 'lock';
    if (c.includes('sensor')) return 'sensor';
    if (c.includes('speaker')) return 'speaker';
    return 'device';
  }
}

// ── Home Assistant (local, long-lived access token) ──────────────

interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export class HomeAssistantAdapter extends TokenPlatformAdapter {
  readonly key = 'homeassistant';
  readonly label = 'Home Assistant';
  readonly help = 'In Home Assistant create a long-lived access token (Profile → Security) and paste it with your server URL.';
  constructor(
    private config: { url?: string; token?: string } = {},
    vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0],
  ) {
    super(vault, 'homeassistant');
    this.baseUrl = (config.url || process.env['UMBRA_HA_URL'] || 'http://homeassistant.local:8123').replace(/\/+$/, '');
    if (!this.token && config.token) this.token = config.token;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const states = await this.request<HaState[]>(
      'GET',
      `${this.baseUrl}/api/states`,
      { headers: { Authorization: await this.authHeader() } },
    );
    return (states || [])
      .filter((s) => /^(switch|light|fan|input_boolean)\./.test(s.entity_id))
      .map((s) => ({
        id: `homeassistant:${s.entity_id}`,
        nativeId: s.entity_id,
        platform: this.key,
        platformLabel: this.label,
        name: String(s.attributes['friendly_name'] || s.entity_id),
        kind: s.entity_id.startsWith('light.') ? 'light' : s.entity_id.startsWith('switch.') ? 'switch' : 'device',
        manufacturer: 'Home Assistant',
        room: 'Unassigned',
        switchCapable: true,
        switchState: s.state === 'on' ? 'on' : s.state === 'off' ? 'off' : null,
        online: s.state !== 'unavailable',
      }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    const domain = nativeId.split('.')[0] || 'switch';
    await this.request('POST', `${this.baseUrl}/api/services/${domain}/turn_${command}`, {
      headers: { Authorization: await this.authHeader(), 'Content-Type': 'application/json' },
      body: { entity_id: nativeId },
    });
    getLogger().info({ platform: this.key, nativeId, command, domain }, 'HomeAssistantAdapter: command sent');
  }
}

// ── CLI-bridge adapters (Apple Home / Alexa / Google Home) ───────

/**
 * Base for platforms without a practical public cloud API: bridge through
 * their official CLIs when installed. `binary` is probed once per call.
 */
export abstract class CliBridgeAdapter implements SmartHomePlatform {
  abstract readonly key: string;
  abstract readonly label: string;
  abstract readonly help: string;
  lastError?: string;

  constructor(
    protected readonly binary: string,
    protected readonly installHint: string,
  ) {}

  /** Probe the CLI binary once — present on PATH means connected. */
  isConfigured(): boolean {
    if (this.probed === undefined) this.probed = this.probeBinary();
    return this.probed;
  }

  private probed?: boolean;

  protected probeBinary(): boolean {
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process');
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFileSync(cmd, [this.binary], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  protected async run(args: string[], timeoutMs = 20000): Promise<string> {
    const { execFile } = await import('child_process');
    return new Promise((resolve, reject) => {
      execFile(this.binary, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${this.binary} failed: ${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  abstract getDevices(opts?: { withStates?: boolean }): Promise<SmartHomeDeviceV2[]>;
  abstract sendCommand(nativeId: string, command: SwitchCommand): Promise<void>;
}

/** Apple Home via the `homebridge`/`athome` CLI surface. */
export class AppleHomeAdapter extends CliBridgeAdapter {
  readonly key = 'applehome';
  readonly label = 'Apple Home';
  readonly help = 'Requires a HomeKit bridge on this machine — install `homebridge` (npm i -g homebridge) or `athome`.';
  readonly installHint = 'npm install -g homebridge';

  constructor() {
    super('homebridge', 'npm install -g homebridge');
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const out = await this.run(['-X', 'accessories']);
    try {
      const parsed = JSON.parse(out) as { accessories?: Array<{ aid: number; type?: string; serviceName?: string; values?: Record<string, unknown> }> };
      return (parsed.accessories || []).map((a) => ({
        id: `applehome:${a.aid}`,
        nativeId: String(a.aid),
        platform: this.key,
        platformLabel: this.label,
        name: a.serviceName || `Accessory ${a.aid}`,
        kind: this.kindFromType(a.type || ''),
        manufacturer: 'Apple Home',
        room: 'Unassigned',
        switchCapable: Boolean(a.values && 'On' in a.values),
        switchState: a.values?.['On'] === true ? 'on' : a.values?.['On'] === false ? 'off' : null,
        online: true,
      }));
    } catch {
      return [];
    }
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.run(['-X', 'accessories', '-s', nativeId, '-c', command === 'on' ? 'On:true' : 'On:false']);
  }

  private kindFromType(type: string): SmartHomeDeviceV2['kind'] {
    const t = type.toLowerCase();
    if (t.includes('lightbulb')) return 'light';
    if (t.includes('outlet')) return 'plug';
    if (t.includes('switch')) return 'switch';
    if (t.includes('thermostat')) return 'thermostat';
    if (t.includes('lock')) return 'lock';
    if (t.includes('sensor')) return 'sensor';
    if (t.includes('speaker')) return 'speaker';
    return 'device';
  }
}

/**
 * Amazon Alexa via `alexa-remote-control`.
 *
 * Amazon publishes NO API for reading or controlling devices that already sit
 * in a user's Alexa account — the Smart Home API only goes the other way
 * (expose your own device cloud to Alexa). So this stays a CLI bridge over the
 * community tool, which signs in with your Amazon credentials.
 *
 * The hard part is not the command, it is the session: that login expires,
 * trips 2FA, and fails with an opaque error. So this adapter's job is to turn
 * those failures into something the user can act on.
 */
export class AlexaAdapter extends CliBridgeAdapter {
  readonly key = 'alexa';
  readonly label = 'Amazon Alexa';
  readonly help = 'Requires `npm i -g alexa-remote-control`, then run `alexa-remote-control -a login` once to link your Amazon account.';
  readonly installHint = 'npm install -g alexa-remote-control';
  readonly credentialsUrl = 'https://alexa-remote-control.thepetejs.dev/';

  constructor() {
    super('alexa-remote-control', 'npm install -g alexa-remote-control');
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const out = await this.run(['-a', 'list']);
    const names = out.split('\n').map((l) => l.trim()).filter(Boolean);
    // `-a list` prints one device per line, optionally as "Name (Group)". The
    // CLI cannot report which of them are switchable, so every device is
    // offered an on/off control; a device that does not support it will say so
    // on the command instead of failing silently.
    return names.map((name) => ({
      id: `alexa:${name}`,
      nativeId: name,
      platform: this.key,
      platformLabel: this.label,
      name,
      kind: 'device',
      manufacturer: 'Amazon',
      room: 'Unassigned',
      switchCapable: true,
      switchState: null,
      online: true,
    }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    // Alexa CLI exposes device control via text commands; on/off map directly.
    await this.run(['-a', 'smarthome', '-d', nativeId, '-c', command === 'on' ? 'ON' : 'OFF']);
  }

  /**
   * Turn the CLI's failure modes into instructions.
   *
   * An expired or unlinked Amazon session is by far the most common problem
   * and the raw output says nothing useful, so it gets a specific message.
   */
  protected override async run(args: string[], timeoutMs = 20000): Promise<string> {
    try {
      return await super.run(args, timeoutMs);
    } catch (e) {
      const raw = `${(e as Error).message || ''}`;
      const lowered = raw.toLowerCase();
      if (/cookie|login|log in|unauthor|401|403|expired|two-factor|2fa|otp|refresh/.test(lowered)) {
        throw new Error(
          'Amazon session expired or is not linked — run `alexa-remote-control -a login` in a terminal ' +
          'and complete the 2FA prompt, then try again.',
        );
      }
      if (/command not found|enoent/.test(lowered)) {
        throw new Error('`alexa-remote-control` is not on PATH — run: npm install -g alexa-remote-control');
      }
      this.lastError = raw;
      throw e;
    }
  }
}

/**
 * Local `ghome` (google-nest-sdm) CLI bridge — a fallback for people who
 * already run it. The official cloud path is GoogleSdmAdapter; this exists
 * because the CLI reaches some devices without a Device Access project.
 */
export class GoogleHomeCliAdapter extends CliBridgeAdapter {
  readonly key = 'ghome';
  readonly label = 'Google Home (local ghome bridge)';
  readonly help = 'Optional fallback: requires the local `ghome` CLI (`pip install google-nest-sdm`) signed in to your Google account.';
  readonly installHint = 'pip install google-nest-sdm';

  constructor() {
    super('ghome', 'pip install google-nest-sdm');
  }

  async getDevices(): Promise<SmartHomeDeviceV2[]> {
    const out = await this.run(['devices', 'list', '--json']);
    try {
      const parsed = JSON.parse(out) as { devices?: Array<{ name?: string; id?: string; type?: string }> };
      return (parsed.devices || []).map((d) => ({
        id: `ghome:${d.id || d.name || ''}`,
        nativeId: d.id || d.name || '',
        platform: this.key,
        platformLabel: this.label,
        name: d.name || d.id || 'Google device',
        kind: this.kindFromType(d.type || ''),
        manufacturer: 'Google',
        room: 'Unassigned',
        switchCapable: true,
        switchState: null,
        online: true,
      }));
    } catch {
      return [];
    }
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    await this.run(['devices', 'send', nativeId, command]);
  }

  private kindFromType(type: string): SmartHomeDeviceV2['kind'] {
    const t = type.toLowerCase();
    if (t.includes('light')) return 'light';
    if (t.includes('plug') || t.includes('outlet')) return 'plug';
    if (t.includes('thermostat')) return 'thermostat';
    if (t.includes('camera')) return 'camera';
    if (t.includes('speaker')) return 'speaker';
    if (t.includes('lock')) return 'lock';
    return 'device';
  }
}

// ── Hub assembly — one instance, all adapters ────────────────────

import { SmartThingsService } from './SmartThingsService';
import { SmartHomeHub } from './SmartHomePlatform';

/**
 * Build the global hub: SmartThings through the existing full-featured
 * service (vault-backed PAT, agent tooling) plus every new adapter.
 */
export function buildSmartHomeHub(deps: {
  vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0];
  smartThings?: SmartThingsService;
  config?: Record<string, { url?: string; token?: string }>;
}): SmartHomeHub {
  const hub = new SmartHomeHub();

  // SmartThings: reuse the existing battle-tested service, wrapped in the
  // platform interface so agent + scheduler keep working unchanged.
  if (deps.smartThings) {
    hub.register(new SmartThingsPlatformWrapper(deps.smartThings, deps.vault));
  } else {
    hub.register(new SmartThingsAdapter(deps.vault));
  }

  hub.register(new HomeAssistantAdapter(deps.config?.homeassistant, deps.vault));
  hub.register(new HubitatAdapter(deps.config?.hubitat, deps.vault));
  hub.register(new OpenhabAdapter(deps.config?.openhab, deps.vault));
  hub.register(new TuyaAdapter(deps.config?.tuya, deps.vault));
  hub.register(new HiveAdapter(deps.config?.hive, deps.vault));
  hub.register(new HomeyAdapter(deps.config?.homey, deps.vault));
  hub.register(new AppleHomeAdapter());
  hub.register(new AlexaAdapter());
  // Google Home: official SDM API (thermostats/cameras/doorbells/displays).
  hub.register(new GoogleSdmAdapter());
  // The local `ghome` bridge stays as a separate fallback platform for anyone
  // who already runs it — it is not replaced, just no longer the only option.
  hub.register(new GoogleHomeCliAdapter());

  return hub;
}

/**
 * Bridges the legacy SmartThingsService into the platform interface.
 *
 * Two credential paths, both first-class:
 *  - pasted PAT → the legacy service, which the agent tools also call directly
 *  - "Sign in with SmartThings" → an internal SmartThingsAdapter, because the
 *    legacy service holds a single long-lived string and cannot refresh a
 *    short-lived OAuth access token
 * Once a session exists the adapter serves device reads and commands so the
 * 401-refresh path can run; the PAT path is untouched otherwise.
 */
export class SmartThingsPlatformWrapper implements SmartHomePlatform {
  readonly key = 'smartthings';
  readonly label = 'Samsung SmartThings';
  readonly help = 'Create a personal access token with Devices (Read + Control) and Rooms (Read) scopes.';
  readonly credentialsUrl = 'https://account.smartthings.com/tokens';
  lastError?: string;

  private readonly oauthAdapter: SmartThingsAdapter;

  constructor(
    private svc: SmartThingsService,
    private vault?: ConstructorParameters<typeof TokenPlatformAdapter>[0],
  ) {
    this.oauthAdapter = new SmartThingsAdapter(vault);
  }

  isConfigured(): boolean {
    return this.svc.isConfigured() || this.oauthAdapter.isConfigured();
  }

  getMaskedToken(): string {
    return this.oauthAdapter.getMaskedToken() || this.svc.getMaskedToken();
  }

  getOAuthProvider(): { name: string; requiresClientApp?: boolean } | undefined {
    return this.oauthAdapter.getOAuthProvider();
  }

  supportsOAuth(): boolean {
    return this.oauthAdapter.supportsOAuth();
  }

  beginOAuth(redirectUri: string): { authorizeUrl: string; state: string } {
    return this.oauthAdapter.beginOAuth(redirectUri);
  }

  async completeOAuth(code: string, state: string): Promise<{ ok: boolean; deviceCount: number; tokenMasked: string }> {
    return this.oauthAdapter.completeOAuth(code, state);
  }

  async setToken(token: string): Promise<{ ok: boolean; deviceCount?: number; tokenMasked?: string }> {
    // Validate FIRST — never touch the stored credential on a failed connect.
    await this.svc.validateToken(token);
    this.svc.setToken(token);
    const devices = await this.svc.getSmartHomeDevices({ withStates: false }).catch(() => [] as Array<{ id: string }>);
    return { ok: true, deviceCount: devices.length, tokenMasked: this.svc.getMaskedToken() };
  }

  async clearToken(): Promise<void> {
    this.svc.clearToken();
    await this.oauthAdapter.clearToken();
  }

  async getDevices(opts?: { withStates?: boolean }): Promise<SmartHomeDeviceV2[]> {
    if (this.oauthAdapter.isConfigured()) {
      return this.oauthAdapter.getDevices(opts);
    }
    const legacy = await this.svc.getSmartHomeDevices({ withStates: opts?.withStates !== false });
    return legacy.map((d) => ({
      ...d,
      id: `smartthings:${d.id}`,
      nativeId: d.id,
      platform: this.key,
      platformLabel: this.label,
    }));
  }

  async sendCommand(nativeId: string, command: SwitchCommand): Promise<void> {
    if (this.oauthAdapter.isConfigured()) {
      await this.oauthAdapter.sendCommand(nativeId, command);
      return;
    }
    await this.svc.sendCommand(nativeId, command);
  }
}
