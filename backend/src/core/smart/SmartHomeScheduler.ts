/**
 * SmartHomeScheduler — cron-style device control for Umbra OS.
 *
 * Lets the agent ("turn the porch light on every day at 7pm") or the user
 * create recurring device schedules. Rules are persisted to
 * ~/.umbra/smart-schedules.json and evaluated by `runDue()`, which is called
 * from the same 30-second tick that drives the social-post scheduler.
 *
 * Rule shape:
 *   { id, deviceId, deviceName, command: 'on'|'off', kind: 'everyMinutes'|'at',
 *     everyMinutes?, at? ("HH:MM"), lastRun?, createdAt, enabled }
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';
import { type SwitchCommand } from './SmartThingsService';

/**
 * The only surface the scheduler needs from a home system. Implemented by
 * `SmartHomeHub` (multi-platform) and structurally by `SmartThingsService`
 * (legacy, single-platform), so rules written before the hub existed keep
 * working untouched.
 */
export interface SmartHomeCommandTarget {
  sendCommand(deviceId: string, command: SwitchCommand): Promise<unknown>;
}

export interface SmartSchedule {
  id: string;
  deviceId: string;
  deviceName: string;
  command: SwitchCommand;
  /** 'everyMinutes' = interval rule; 'at' = daily at HH:MM. */
  kind: 'everyMinutes' | 'at';
  everyMinutes?: number;
  /** Daily time "HH:MM" (24h, local time). */
  at?: string;
  lastRun?: number;
  createdAt: number;
  enabled: boolean;
}

const STORE_FILE = 'smart-schedules.json';

export class SmartHomeScheduler {
  private svc: SmartHomeCommandTarget;
  private dataDir: string;
  private rules: SmartSchedule[] = [];
  private loaded = false;

  constructor(svc: SmartHomeCommandTarget, dataDir?: string) {
    this.svc = svc;
    this.dataDir = dataDir || path.join(process.env['USERPROFILE'] || process.env['HOME'] || '.', '.umbra');
  }

  private file(): string {
    return path.join(this.dataDir, STORE_FILE);
  }

  private load(): void {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(this.file(), 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        this.rules = arr.filter((r) => r && typeof r.id === 'string' && typeof r.deviceId === 'string');
      }
    } catch { /* no file yet */ }
    this.loaded = true;
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file(), JSON.stringify(this.rules, null, 2));
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, 'SmartHomeScheduler: failed to persist');
    }
  }

  list(): SmartSchedule[] {
    this.load();
    return [...this.rules];
  }

  add(rule: Omit<SmartSchedule, 'id' | 'createdAt' | 'lastRun' | 'enabled'>): SmartSchedule {
    this.load();
    const full: SmartSchedule = {
      ...rule,
      id: `sm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      lastRun: undefined,
      enabled: true,
    };
    this.rules.push(full);
    this.save();
    getLogger().info({ id: full.id, device: full.deviceName, command: full.command }, 'SmartHomeScheduler: rule added');
    return full;
  }

  cancel(id: string): boolean {
    this.load();
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length !== before) {
      this.save();
      getLogger().info({ id }, 'SmartHomeScheduler: rule cancelled');
      return true;
    }
    return false;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    this.load();
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = enabled;
    this.save();
    return true;
  }

  /** Is this rule due at time `now`? */
  private isDue(rule: SmartSchedule, now: number): boolean {
    if (!rule.enabled) return false;
    if (rule.kind === 'everyMinutes') {
      const interval = Math.max(1, rule.everyMinutes || 1) * 60_000;
      return !rule.lastRun || now - rule.lastRun >= interval;
    }
    // Daily 'at HH:MM' — due when the current time is past today's target and
    // we haven't already run it since that moment.
    const [hh, mm] = (rule.at || '00:00').split(':').map((x) => parseInt(x, 10) || 0);
    const d = new Date(now);
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
    if (now < target) return false;
    return !rule.lastRun || rule.lastRun < target;
  }

  /** Execute all due rules. Called from the app's 30s tick. */
  async runDue(now: number = Date.now()): Promise<Array<{ id: string; ok: boolean; device: string; command: SwitchCommand; error?: string }>> {
    this.load();
    const due = this.rules.filter((r) => this.isDue(r, now));
    const results: Array<{ id: string; ok: boolean; device: string; command: SwitchCommand; error?: string }> = [];
    for (const rule of due) {
      try {
        await this.svc.sendCommand(rule.deviceId, rule.command);
        rule.lastRun = Date.now();
        results.push({ id: rule.id, ok: true, device: rule.deviceName, command: rule.command });
        getLogger().info({ id: rule.id, device: rule.deviceName, command: rule.command }, 'SmartHomeScheduler: rule executed');
      } catch (err) {
        // Keep lastRun so a failing rule doesn't hammer the API every 30s;
        // it will retry on its next natural window.
        rule.lastRun = Date.now();
        results.push({ id: rule.id, ok: false, device: rule.deviceName, command: rule.command, error: (err as Error).message });
        getLogger().warn({ id: rule.id, err: (err as Error).message }, 'SmartHomeScheduler: rule failed');
      }
    }
    if (due.length > 0) this.save();
    return results;
  }
}
