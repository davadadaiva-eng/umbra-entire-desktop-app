import { getLogger } from '../Logger';

export interface InputEvent {
  type: 'click' | 'move' | 'key' | 'scroll';
  x?: number;
  y?: number;
  key?: string;
  button?: number;
  delta?: number;
  source: 'physical' | 'synthetic';
  targetDisplay: number;
}

export type InputGuardMode = 'isolate' | 'passthrough' | 'blocked';

export class InputGuard {
  private mode: InputGuardMode = 'isolate';
  private physicalInputsBlocked: number = 0;
  private desktop1Bounds: { x: number; y: number; width: number; height: number };
  private virtualDisplayRegions: Map<number, { x: number; y: number; width: number; height: number }> = new Map();

  constructor() {
    const primaryDisplay = this.getPrimaryDisplayBounds();
    this.desktop1Bounds = primaryDisplay;
  }

  registerVirtualDisplay(id: number, region: { x: number; y: number; width: number; height: number }): void {
    this.virtualDisplayRegions.set(id, region);
    getLogger().info({ id, region }, 'Virtual display region registered with InputGuard');
  }

  unregisterVirtualDisplay(id: number): void {
    this.virtualDisplayRegions.delete(id);
  }

  inspectInput(event: InputEvent): boolean {
    if (event.source === 'synthetic') return true;

    this.physicalInputsBlocked++;

    if (this.mode === 'blocked') {
      getLogger().warn({ event }, 'Input blocked — guard is in blocked mode');
      return false;
    }

    const onDesktop2 = this.isInVirtualRegion(event.x || 0, event.y || 0);
    if (onDesktop2) {
      getLogger().warn({ event }, 'Physical input attempted to enter Desktop 2 — blocked');
      return false;
    }

    return true;
  }

  setMode(mode: InputGuardMode): void {
    this.mode = mode;
    getLogger().info({ mode }, 'InputGuard mode changed');
  }

  getMode(): InputGuardMode {
    return this.mode;
  }

  async sendSyntheticInput(displayId: number, event: Omit<InputEvent, 'source' | 'targetDisplay'>): Promise<void> {
    const region = this.virtualDisplayRegions.get(displayId);
    if (!region) throw new Error(`Display ${displayId} not registered with InputGuard`);

    try {
      const native = await import('../../native/win32/InputNative');
      const x = (event.x || 0) + region.x;
      const y = (event.y || 0) + region.y;

      switch (event.type) {
        case 'click':
          native.sendClick(x, y, event.button || 0);
          break;
        case 'key':
          native.sendKey(event.key || '');
          break;
        case 'scroll':
          native.sendScroll(x, y, event.delta || 0);
          break;
        case 'move':
          native.sendMouseMove(x, y);
          break;
      }
    } catch {
      getLogger().debug({ displayId, event }, 'Synthetic input (native not available — simulated)');
    }
  }

  async typeText(displayId: number, text: string): Promise<void> {
    try {
      const native = await import('../../native/win32/InputNative');
      native.typeText(text);
    } catch {
      getLogger().debug({ displayId, text: text.substring(0, 50) }, 'Type text (native not available — simulated)');
    }
  }

  getPhysicalInputsBlocked(): number {
    return this.physicalInputsBlocked;
  }

  private isInVirtualRegion(x: number, y: number): boolean {
    for (const region of this.virtualDisplayRegions.values()) {
      if (
        x >= region.x && x < region.x + region.width &&
        y >= region.y && y < region.y + region.height
      ) {
        return true;
      }
    }
    return false;
  }

  private getPrimaryDisplayBounds(): { x: number; y: number; width: number; height: number } {
    // Try to read actual display bounds from native module, fallback to common 1080p
    try {
      const native = require('../../native/win32/VirtualDisplayNative');
      if (native?.getPrimaryDisplayBounds) {
        return native.getPrimaryDisplayBounds();
      }
    } catch { /* not available */ }
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
}
