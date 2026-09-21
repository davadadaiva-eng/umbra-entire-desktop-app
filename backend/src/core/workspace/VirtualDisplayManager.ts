import { DisplayStatus } from '../../types';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';

export interface VirtualDisplay {
  id: number;
  width: number;
  height: number;
  fps: number;
  status: DisplayStatus;
  createdAt: Date;
  nativeHandle: number | null;
}

export class VirtualDisplayManager {
  private displays: Map<number, VirtualDisplay> = new Map();
  private nextId: number = 0;
  private maxDisplays: number;
  private displayWidth: number;
  private displayHeight: number;
  private displayFps: number;

  constructor(config: {
    maxDisplays: number;
    displayWidth: number;
    displayHeight: number;
    displayFps: number;
  }) {
    this.maxDisplays = config.maxDisplays;
    this.displayWidth = config.displayWidth;
    this.displayHeight = config.displayHeight;
    this.displayFps = config.displayFps;
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
    getLogger().info({ id, width: display.width, height: display.height }, 'Virtual display created');

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

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.displays.keys());
    await Promise.all(ids.map(id => this.destroy(id)));
  }

  private async createNativeDisplay(id: number): Promise<number> {
    try {
      const native = await import('../../native/win32/VirtualDisplayNative');
      return native.createVirtualDisplay(id, this.displayWidth, this.displayHeight, this.displayFps);
    } catch {
      throw new Error('Native display module not available');
    }
  }

  private async destroyNativeDisplay(nativeHandle: number): Promise<void> {
    try {
      const native = await import('../../native/win32/VirtualDisplayNative');
      return native.destroyVirtualDisplay(nativeHandle);
    } catch {
      throw new Error('Native display module not available');
    }
  }

  private async captureNativeDisplay(handle: number): Promise<Buffer> {
    try {
      const native = await import('../../native/win32/VirtualDisplayNative');
      return native.captureDisplayBuffer(handle);
    } catch {
      throw new Error('Native capture not available');
    }
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
