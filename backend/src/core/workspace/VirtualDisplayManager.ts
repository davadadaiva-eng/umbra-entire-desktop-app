import { DisplayStatus } from '../../types';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';
import * as native from '../../native/win32/VirtualDisplayNative';

export interface VirtualDisplay {
  id: number;
  width: number;
  height: number;
  fps: number;
  status: DisplayStatus;
  createdAt: Date;
  nativeHandle: number | null;
  region: { x: number; y: number; width: number; height: number };
}

export interface ActiveDisplayInfo {
  id: number;
  width: number;
  height: number;
  fps: number;
  status: DisplayStatus;
  nativeHandle: number | null;
  region: { x: number; y: number; width: number; height: number };
  hasContent: boolean;
}

export class VirtualDisplayManager {
  private displays: Map<number, VirtualDisplay> = new Map();
  private nextId: number = 0;
  private maxDisplays: number;
  private displayWidth: number;
  private displayHeight: number;
  private displayFps: number;
  private regionXOffset: number;

  constructor(config: {
    maxDisplays: number;
    displayWidth: number;
    displayHeight: number;
    displayFps: number;
    regionXOffset?: number;
  }) {
    this.maxDisplays = config.maxDisplays;
    this.displayWidth = config.displayWidth;
    this.displayHeight = config.displayHeight;
    this.displayFps = config.displayFps;
    this.regionXOffset = config.regionXOffset ?? 0;
  }

  async create(): Promise<VirtualDisplay> {
    if (this.displays.size >= this.maxDisplays) {
      throw new Error(`Maximum displays reached (${this.maxDisplays})`);
    }

    const id = this.nextId++;
    const display: VirtualDisplay = {
      id,
      width: this.displayWidth,
      height: this.displayHeight,
      fps: this.displayFps,
      status: 'allocated',
      createdAt: new Date(),
      nativeHandle: null,
      region: {
        x: this.regionXOffset + id * this.displayWidth,
        y: 0,
        width: this.displayWidth,
        height: this.displayHeight,
      },
    };

    try {
      const nativeId = await this.createNativeDisplay(id);
      display.nativeHandle = nativeId;
      display.status = 'active';
    } catch (err: any) {
      getLogger().warn({ id, err: err.message }, 'Native display creation failed, using virtual buffer');
      display.status = 'active';
    }

    this.displays.set(id, display);
    eventBus.emit('display:created', id);
    getLogger().info(
      { id, width: display.width, height: display.height, region: display.region, nativeHandle: display.nativeHandle },
      'Virtual display created'
    );

    return display;
  }

  async destroy(id: number): Promise<void> {
    const display = this.displays.get(id);
    if (!display) throw new Error(`Display ${id} not found`);

    try {
      if (display.nativeHandle !== null) {
        await this.destroyNativeDisplay(display.nativeHandle);
      }
    } catch (err: any) {
      getLogger().warn({ id, err: err.message }, 'Native display destruction failed');
    }

    this.displays.delete(id);
    eventBus.emit('display:destroyed', id);
    getLogger().info({ id }, 'Virtual display destroyed');
  }

  async capture(id: number): Promise<Buffer | null> {
    const display = this.displays.get(id);
    if (!display || display.status !== 'active') return null;

    try {
      return await this.captureNativeDisplay(display.nativeHandle || id);
    } catch {
      return this.captureVirtualBuffer(id);
    }
  }

  getDisplay(id: number): VirtualDisplay | undefined {
    return this.displays.get(id);
  }

  getAllDisplays(): VirtualDisplay[] {
    return Array.from(this.displays.values());
  }

  getActiveCount(): number {
    return Array.from(this.displays.values()).filter(d => d.status === 'active').length;
  }

  /**
   * Returns enriched info for every active display, including whether the
   * framebuffer currently holds rendered content. Used by Desktop2Environment
   * and InputGuard to map synthetic coordinates to virtual regions.
   */
  getActiveDisplays(): ActiveDisplayInfo[] {
    const nativeMap = new Map<number, { hasContent: boolean }>();
    try {
      for (const info of native.getActiveDisplays()) {
        nativeMap.set(info.handle, { hasContent: info.hasContent });
      }
    } catch {
      // native not available — hasContent will default to false
    }

    return Array.from(this.displays.values())
      .filter(d => d.status === 'active')
      .map(d => {
        const nativeInfo = d.nativeHandle !== null ? nativeMap.get(d.nativeHandle) : undefined;
        return {
          id: d.id,
          width: d.width,
          height: d.height,
          fps: d.fps,
          status: d.status,
          nativeHandle: d.nativeHandle,
          region: d.region,
          hasContent: nativeInfo ? nativeInfo.hasContent : false,
        };
      });
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.displays.keys());
    await Promise.all(ids.map(id => this.destroy(id)));
  }

  private async createNativeDisplay(id: number): Promise<number> {
    return native.createVirtualDisplay(id, this.displayWidth, this.displayHeight, this.displayFps);
  }

  private async destroyNativeDisplay(nativeHandle: number): Promise<void> {
    return native.destroyVirtualDisplay(nativeHandle);
  }

  private async captureNativeDisplay(handle: number): Promise<Buffer> {
    return native.captureDisplayBuffer(handle);
  }

  private async captureVirtualBuffer(_id: number): Promise<Buffer> {
    // Gray placeholder frame (RGBA: 30, 30, 30, 255)
    const size = this.displayWidth * this.displayHeight * 4;
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4) {
      buf[i] = 30;     // R
      buf[i + 1] = 30; // G
      buf[i + 2] = 30; // B
      buf[i + 3] = 255; // A
    }
    return buf;
  }
}