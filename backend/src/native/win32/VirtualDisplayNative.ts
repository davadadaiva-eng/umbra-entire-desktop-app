/**
 * Virtual Display Native — Windows IDDCX Driver Interface
 *
 * This module wraps the C++ IDDCX indirect display driver.
 * The driver creates virtual monitors that appear as physical
 * displays to Windows but route pixels to Umbra's frame buffer.
 *
 * Build requirements:
 * - Windows Driver Kit (WDK)
 * - Visual Studio with C++ desktop development
 * - WHQL-signed driver for production
 *
 * Current implementation is a stub that simulates display operations
 * for development and testing.
 */

let nextHandle = 1000;
const activeDisplays = new Map<number, { id: number; buffer: Buffer }>();

export async function createVirtualDisplay(
  id: number,
  width: number,
  height: number,
  fps: number
): Promise<number> {
  const handle = nextHandle++;
  const bufferSize = width * height * 4; // BGRA32
  const buffer = Buffer.alloc(bufferSize, 0);

  activeDisplays.set(handle, { id, buffer });

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(`[IDDCX-Stub] Created virtual display #${id} (${width}x${height} @${fps}fps) handle=${handle}`);
  }

  return handle;
}

export async function destroyVirtualDisplay(handle: number): Promise<void> {
  activeDisplays.delete(handle);

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(`[IDDCX-Stub] Destroyed virtual display handle=${handle}`);
  }
}

export async function captureDisplayBuffer(handle: number): Promise<Buffer> {
  const display = activeDisplays.get(handle);
  if (!display) throw new Error(`Display handle ${handle} not found`);
  return display.buffer;
}

export async function sendFrameToDisplay(
  handle: number,
  frameData: Buffer
): Promise<void> {
  const display = activeDisplays.get(handle);
  if (!display) throw new Error(`Display handle ${handle} not found`);

  if (frameData.length !== display.buffer.length) {
    throw new Error(`Frame data size mismatch: expected ${display.buffer.length}, got ${frameData.length}`);
  }

  frameData.copy(display.buffer);
}

export function getActiveDisplayCount(): number {
  return activeDisplays.size;
}
