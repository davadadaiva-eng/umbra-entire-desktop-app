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

import { HttpBridge } from '../agent/HttpBridge';
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
  private vault?: { find(s: string): { secret: string } | undefined; set(e: { service: string; username: string; secret: string }, id?: string): unknown; remove(s: string): boolean; isUnlocked: boolean };

  constructor(cfg?: Partial<SmartThingsConfig>, vault?: { find(s: string): { secret: string } | undefined; set(e: { service: string; username: string; secret: string }, id?: string): unknown; remove(s: string): boolean; isUnlocked: boolean }) {
    this.cfg = { ...smartThingsConfigFromEnv(), ...cfg };
    if (vault) this.vault = vault;
    // Vault token overrides env — per-user encrypted storage, survives restart
    try {
      const v = this.vault?.find('smartthings')?.secret?.trim();
      if (v) { this.cfg.token = v; this.cfg.enabled = true; }
    } catch {}
  }

  get enabled(): boolean {
    return this.cfg.enabled && !!this.cfg.token;
  }

  isConfigured(): boolean {
    return this.enabled;
  }

  /** Attach vault after construction (composition-root wiring). */
  setVault(vault: { find(s: string): { secret: string } | undefined; set(e: { service: string; username: string; secret: string }, id?: string): unknown; remove(s: string): boolean; isUnlocked: boolean }): void {
    this.vault = vault;
    try {
      const v = vault.find('smartthings')?.secret?.trim();
      if (v) { this.cfg.token = v; this.cfg.enabled = true; }
    } catch {}
  }

  getMaskedToken(): string {
    const t = this.cfg.token || '';
    if (!t) return '';
    if (t.length <= 8) return '••••';
    return t.slice(0, 4) + '••••' + t.slice(-4);
  }

  /** Persist PAT to vault (encrypted) and activate immediately. Validate before calling. */
  setToken(token: string): void {
    const t = token.trim();
    if (!t) throw new Error('Token is required');
    if (!this.vault || !this.vault.isUnlocked) throw new Error('Credential vault is locked — restart Umbra');
    this.vault.set({ service: 'smartthings', username: 'pat', secret: t } as any);
    this.cfg.token = t;
    this.cfg.enabled = true;
    this.nameCache.clear();
    this.cacheAt = 0;
  }

  clearToken(): void {
    if (this.vault?.isUnlocked) {
      try { this.vault.remove('smartthings'); } catch {}
    }
    // Fall back to env
    const env = smartThingsConfigFromEnv();
    this.cfg.token = env.token;
    this.cfg.enabled = env.enabled;
    this.nameCache.clear();
    this.cacheAt = 0;
  }

  /** Validate token by fetching one page of devices — throws 401/403 with human message. */
  async validateToken(token?: string): Promise<{ ok: boolean; deviceCount: number }> {
    const prev = this.cfg.token;
    const prevEnabled = this.cfg.enabled;
    if (token) { this.cfg.token = token.trim(); this.cfg.enabled = !!token.trim(); }
    try {
      const devices = await this.request<{ items?: unknown[] }>('GET', '/v1/devices?max=2');
      const count = Array.isArray((devices as any).items) ? (devices as any).items.length : 0;
      return { ok: true, deviceCount: count };
    } finally {
      if (token) { this.cfg.token = prev; this.cfg.enabled = prevEnabled; }
    }
  }

  // ── Transport ─────────────────────────────────────────────────
  // Use curl via HttpBridge to bypass Node v24 TLS stack (same as LLMConnector).
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    const url = this.cfg.baseUrl.replace(/\/+$/, '') + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: 'application/json',
    };
    const res = await HttpBridge.request({ url, method, headers, body, timeoutMs });
    if (res.status < 200 || res.status >= 300) {
      const parsed = res.data;
      let msg = typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `SmartThings HTTP ${res.status}`;
      if (res.status === 401) msg = 'SmartThings PAT expired/revoked — regenerate at account.smartthings.com/tokens';
      if (res.status === 403) msg = 'SmartThings PAT missing devices/rooms scope — recreate token with required scopes';
      throw new Error(msg);
    }
    return (res.data ?? {}) as T;
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
    if (devices.length === 0) return [];
    const rooms = new Map<string, string>();
    // Rooms are per-location (/v1/locations/{id}/rooms). Global /v1/rooms 404s — try locations.
    const roomsWithTimeout = async (path: string, ms: number): Promise<void> => {
      try {
        const roomsRes = await Promise.race([
          this.request<{ items?: Array<{ roomId: string; name?: string }> }>('GET', path),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('rooms timeout')), ms)),
        ]);
        for (const r of (roomsRes as any).items || []) if (r.roomId) rooms.set(r.roomId, r.name || r.roomId);
      } catch { /* rooms are optional — ignore */ }
    };
    // First try global (old accounts still support it, 2s budget), then per-location
    await roomsWithTimeout('/v1/rooms', 2500);
    if (rooms.size === 0) {
      try {
        const locRes = await Promise.race([
          this.request<{ items?: Array<{ locationId: string }> }>('GET', '/v1/locations'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('locations timeout')), 2500)),
        ]);
        for (const loc of (locRes as any).items || []) {
          await roomsWithTimeout(`/v1/locations/${encodeURIComponent(loc.locationId)}/rooms`, 2000);
        }
      } catch {}
    }

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
