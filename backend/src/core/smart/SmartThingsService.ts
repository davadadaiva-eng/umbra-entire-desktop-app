/**
 * SmartThingsService — server-side client for the Samsung SmartThings REST API.
 *
 * Handles:
 *  - GET  {baseUrl}/v1/devices                             → all connected devices (paginated)
 *  - GET  {baseUrl}/v1/devices/{id}/components/main/status → current switch state
 *  - POST {baseUrl}/v1/devices/{deviceId}/commands         → switch capability on/off
 *
 * Authentication uses a Bearer token (config `smartthings.token`, which
 * defaults from `UMBRA_SMARTTHINGS_TOKEN`). Used by the agent planner
 * (sm_devices / sm_on / sm_off / sm_schedule) and the /api/smart/* routes.
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { getLogger } from '../Logger';

export interface SmartThingsDevice {
  deviceId: string;
  name: string;
  label: string;
  locationId?: string;
  roomId?: string;
  components: Array<{
    id: string;
    label?: string;
    capabilities: Array<{ id: string; version?: number }>;
  }>;
  manufacturerName?: string;
}

export interface SmartHomeDevice {
  id: string;
  name: string;
  kind: 'light' | 'switch' | 'plug' | 'sensor' | 'thermostat' | 'lock' | 'device';
  manufacturer: string;
  room: string;
  switchCapable: boolean;
  switchState: 'on' | 'off' | null;
  online: boolean;
}

export type SwitchCommand = 'on' | 'off';

export interface SmartThingsConfig {
  enabled: boolean;
  token: string;
  baseUrl: string;
}

export function smartThingsConfigFromEnv(): SmartThingsConfig {
  const token = process.env['UMBRA_SMARTTHINGS_TOKEN'] || process.env['SMARTTHINGS_TOKEN'] || process.env['VITE_SMARTTHINGS_TOKEN'] || '';
  return {
    enabled: !!token,
    token,
    baseUrl: (process.env['UMBRA_SMARTTHINGS_URL'] || process.env['VITE_SMARTTHINGS_URL'] || process.env['SMARTTHINGS_URL'] || 'https://api.smartthings.com').replace(/\/+$/, ''),
  };
}

const SWITCH_CAPABILITY = 'switch';

/** Standard switch-capability command payload. */
export function switchCommandPayload(command: SwitchCommand) {
  return {
    commands: [
      {
        component: 'main',
        capability: SWITCH_CAPABILITY,
        command, // 'on' | 'off'
        arguments: [],
      },
    ],
  };
}

export class SmartThingsService {
  private cfg: SmartThingsConfig;
  /** deviceId → label cache so the LLM can address devices by name. */
  private nameCache: Map<string, string> = new Map();
  private cacheAt = 0;
  private static CACHE_TTL_MS = 60_000;

  constructor(cfg?: Partial<SmartThingsConfig>) {
    this.cfg = { ...smartThingsConfigFromEnv(), ...cfg };
  }

  get enabled(): boolean {
    return this.cfg.enabled && !!this.cfg.token;
  }

  isConfigured(): boolean {
    return this.enabled;
  }

  // ── Transport ─────────────────────────────────────────────────

  private request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    const base = new URL(this.cfg.baseUrl);
    return new Promise<T>((resolve, reject) => {
      const url = new URL(base.origin + path);
      const payload = body === undefined ? null : JSON.stringify(body);
      const mod = url.protocol === 'http:' ? http : https;
      const req = mod.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + url.search,
          headers: {
            Authorization: `Bearer ${this.cfg.token}`,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            let parsed: unknown = null;
            try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              let msg = typeof parsed === 'object' && parsed !== null && 'message' in parsed
                ? String((parsed as { message: unknown }).message)
                : `SmartThings HTTP ${status}`;
              if (status === 401) msg = 'SmartThings PAT expired/revoked — regenerate at account.smartthings.com/tokens';
              if (status === 403) msg = 'SmartThings PAT missing devices/rooms scope — recreate token with required scopes';
              reject(new Error(msg));
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('SmartThings request timed out')));
      req.on('error', (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── API operations ────────────────────────────────────────────

  /** Fetch ALL connected devices, following pagination links. */
  async listDevices(): Promise<SmartThingsDevice[]> {
    const all: SmartThingsDevice[] = [];
    let path = '/v1/devices?max=200';
    for (let i = 0; i < 10; i++) {
      const page = await this.request<{ items?: SmartThingsDevice[]; next?: string }>('GET', path);
      all.push(...(page.items || []));
      if (!page.next) break;
      path = page.next.startsWith('http') ? page.next.replace(this.cfg.baseUrl, '') : page.next;
    }
    // Refresh the name cache for LLM name-based control.
    this.nameCache = new Map(all.map((d) => [d.deviceId, d.label || d.name || d.deviceId]));
    this.cacheAt = Date.now();
    return all;
  }

  private async cachedNames(): Promise<Map<string, string>> {
    if (Date.now() - this.cacheAt > SmartThingsService.CACHE_TTL_MS || this.nameCache.size === 0) {
      await this.listDevices().catch(() => undefined);
    }
    return this.nameCache;
  }

  /** Resolve a device by (fuzzy) name — used by the agent's natural-language commands. */
  async resolveDevice(name: string): Promise<SmartThingsDevice | null> {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    const devices = await this.listDevices();
    // 1. exact label match
    let hit = devices.find((d) => (d.label || d.name || '').toLowerCase() === q);
    if (hit) return hit;
    // 2. substring containment
    hit = devices.find((d) => (d.label || d.name || '').toLowerCase().includes(q));
    if (hit) return hit;
    // 3. token overlap (e.g. "living room lamp" ≈ "Lamp — Living Room")
    const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    let best: { d: SmartThingsDevice; score: number } | null = null;
    for (const d of devices) {
      const label = (d.label || d.name || '').toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (label.includes(t) ? 1 : 0), 0);
      if (score > 0 && (!best || score > best.score)) best = { d, score };
    }
    return best ? best.d : null;
  }

  /** Read the current switch state (on/off) of a device's main component. */
  async getSwitchState(deviceId: string): Promise<'on' | 'off' | null> {
    try {
      const status = await this.request<{ switch?: { value?: unknown } }>(
        'GET',
        `/v1/devices/${encodeURIComponent(deviceId)}/components/main/status`,
      );
      const v = status?.switch?.value;
      if (v === 'on' || v === true) return 'on';
      if (v === 'off' || v === false) return 'off';
      return null;
    } catch {
      return null;
    }
  }

  /** Turn a device on/off using the standard switch capability payload. */
  async sendCommand(deviceId: string, command: SwitchCommand): Promise<{ ok: boolean; deviceId: string; command: SwitchCommand; name?: string }> {
    await this.request<unknown>(
      'POST',
      `/v1/devices/${encodeURIComponent(deviceId)}/commands`,
      switchCommandPayload(command),
    );
    getLogger().info({ deviceId, command }, 'SmartThings: command sent');
    return { ok: true, deviceId, command, name: this.nameCache.get(deviceId) };
  }

  /** Control a device by (fuzzy) name — the agent-facing entry point. */
  async controlByName(name: string, command: SwitchCommand): Promise<{ ok: boolean; deviceId: string; name: string; command: SwitchCommand }> {
    const device = await this.resolveDevice(name);
    if (!device) throw new Error(`No SmartThings device matching "${name}"`);
    await this.sendCommand(device.deviceId, command);
    return { ok: true, deviceId: device.deviceId, name: device.label || device.name, command };
  }

  // ── Normalization for the dashboard/API ───────────────────────

  private hasCap(d: SmartThingsDevice, cap: string): boolean {
    return d.components.some((c) => c.capabilities.some((x) => x.id === cap));
  }

  private deriveKind(d: SmartThingsDevice): SmartHomeDevice['kind'] {
    const caps = d.components.flatMap((c) => c.capabilities.map((x) => x.id));
    const label = (d.label || d.name || '').toLowerCase();
    if (caps.includes('colorControl') || (caps.includes('switch') && caps.includes('switchLevel') && label.includes('light'))) return 'light';
    if (caps.includes('switchLevel')) return 'switch';
    if (caps.includes('outlet') || caps.includes('relaySwitch')) return 'plug';
    if (caps.includes(SWITCH_CAPABILITY)) return 'switch';
    if (caps.includes('thermostat') || caps.includes('airConditionerMode') || caps.includes('temperatureMeasurement')) return 'thermostat';
    if (caps.includes('lock')) return 'lock';
    if (caps.includes('motionSensor') || caps.includes('contactSensor') || caps.includes('presenceSensor') || caps.includes('waterSensor') || caps.includes('smokeDetector')) return 'sensor';
    return 'device';
  }

  /**
   * Fetch every device, normalize it and enrich switch-capable devices with
   * live on/off state (batched for speed).
   */
  async getSmartHomeDevices(opts?: { withStates?: boolean }): Promise<SmartHomeDevice[]> {
    const withStates = opts?.withStates !== false;
    const devices = await this.listDevices();
    const rooms = new Map<string, string>();
    try {
      const roomsRes = await this.request<{ items?: Array<{ roomId: string; name?: string }> }>('GET', '/v1/rooms');
      for (const r of roomsRes.items || []) if (r.roomId) rooms.set(r.roomId, r.name || r.roomId);
    } catch { /* rooms are optional */ }

    const normalized: SmartHomeDevice[] = devices.map((d) => ({
      id: d.deviceId,
      name: d.label || d.name || d.deviceId,
      kind: this.deriveKind(d),
      manufacturer: d.manufacturerName || 'Unknown',
      room: d.roomId ? rooms.get(d.roomId) || 'Unassigned' : 'Unassigned',
      switchCapable: this.hasCap(d, SWITCH_CAPABILITY),
      switchState: null,
      online: true,
    }));

    if (withStates) {
      const capable = normalized.filter((d) => d.switchCapable);
      const batchSize = 8;
      for (let i = 0; i < capable.length; i += batchSize) {
        const batch = capable.slice(i, i + batchSize);
        const states = await Promise.all(batch.map((d) => this.getSwitchState(d.id)));
        states.forEach((s, idx) => { batch[idx].switchState = s; });
      }
    }
    return normalized;
  }
}
