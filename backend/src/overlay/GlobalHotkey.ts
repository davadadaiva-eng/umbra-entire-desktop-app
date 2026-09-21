/**
 * GlobalHotkey — a lightweight, dependency-free global hotkey listener.
 *
 * Windows has no trivial way to register a system-wide hotkey from Node
 * without a native window/message loop, so this polls `GetAsyncKeyState`
 * (via NativeCore's long-lived daemon) and emits an event on the rising edge
 * of a key combo. Polling is cheap (one JSON line over the daemon's stdin per
 * sample) and is only active while `start()` is running.
 *
 * The key check is injected, so the class is fully unit-testable without
 * touching the OS.
 */
import { isKeyDown } from '../native/win32/NativeCore';
import { eventBus } from '../core/EventBus';
import { getLogger } from '../core/Logger';

export type KeyCheckFn = (vk: number) => Promise<boolean>;

const VK: Record<string, number> = {
  ctrl: 17, control: 17,
  shift: 16,
  alt: 18,
  cmd: 91, meta: 91, win: 91, super: 91,
  space: 32, enter: 13, return: 13, escape: 27, esc: 27, tab: 9,
  backspace: 8, delete: 46, insert: 45, home: 36, end: 35, pageup: 33, pagedown: 34,
  up: 38, down: 40, left: 37, right: 39,
};

function vkFor(part: string): number {
  const p = part.trim().toLowerCase();
  if (!p) return 0;
  if (VK[p] !== undefined) return VK[p];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) return 0x70 + (parseInt(p.slice(1), 10) - 1);
  if (/^[a-z]$/.test(p)) return p.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(p)) return p.charCodeAt(0);
  return 0;
}

/** Parse "Ctrl+Shift+Space" (or "Cmd+K") into Win32 virtual-key codes. */
export function parseHotkey(combo: string): number[] {
  if (!combo) return [];
  return combo.split('+').map(vkFor).filter(v => v !== 0);
}

/** Build a "combo is currently down" predicate from a list of VK codes. */
export function buildKeyCheck(vks: number[], check: KeyCheckFn = isKeyDown): () => Promise<boolean> {
  return async () => {
    for (const vk of vks) {
      if (!(await check(vk))) return false;
    }
    return true;
  };
}

export interface GlobalHotkeyOptions {
  /** Combo string, e.g. "Ctrl+Shift+Space". */
  combo: string;
  /** Event to emit when the combo is pressed (default 'overlay:toggle'). */
  event?: 'overlay:toggle' | 'overlay:command';
  /** Command text for the 'overlay:command' event. */
  command?: string;
  /** Called on the rising edge (combo pressed). */
  onPress?: () => void;
  /** Called on the falling edge (combo released after a press). */
  onRelease?: () => void;
  /** Poll interval in ms (default 200). */
  pollMs?: number;
  /** Injectable key-state check for tests (defaults to NativeCore.isKeyDown). */
  check?: KeyCheckFn;
}

export class GlobalHotkey {
  private check: () => Promise<boolean>;
  private event: 'overlay:toggle' | 'overlay:command';
  private command?: string;
  private pollMs: number;
  private timer?: NodeJS.Timeout;
  private onPress?: () => void;
  private onRelease?: () => void;
  private pressed = false;
  private running = false;

  constructor(options: GlobalHotkeyOptions) {
    const vks = parseHotkey(options.combo);
    if (vks.length === 0) throw new Error(`Invalid or unsupported hotkey: "${options.combo}"`);
    this.check = buildKeyCheck(vks, options.check);
    this.event = options.event ?? 'overlay:toggle';
    this.command = options.command;
    this.onPress = options.onPress;
    this.onRelease = options.onRelease;
    this.pollMs = options.pollMs ?? 200;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pressed = false;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    getLogger().info({ pollMs: this.pollMs, event: this.event }, 'Global hotkey listener started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One sample of the key state; fires the event on the rising edge. */
  async poll(): Promise<boolean> {
    const down = await this.check().catch(() => false);
    if (down && !this.pressed) {
      this.pressed = true;
      this.onPress?.();
      if (this.event === 'overlay:toggle') {
        eventBus.emit('overlay:toggle');
      } else {
        eventBus.emit('overlay:command', this.command ?? '');
      }
      return true;
    }
    if (!down && this.pressed) {
      this.pressed = false;
      this.onRelease?.();
    }
    return false;
  }
}
