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
 * PRODUCTION: When the WHQL-signed IDDCX driver is available, replace the
 * software fallback below with a native binding (ffi-napi / node-ffi) that
 * calls into the driver. The public API surface (createVirtualDisplay,
 * destroyVirtualDisplay, captureDisplayBuffer, sendFrameToDisplay,
 * getActiveDisplays, getPrimaryDisplayBounds) must remain stable.
 *
 * SOFTWARE FALLBACK (current): Maintains a real offscreen framebuffer per
 * virtual display. Frames are written via sendFrameToDisplay and read back
 * via captureDisplayBuffer — the captured pixels are the actual buffer
 * contents, not zeros. This is enough for the Desktop 2 / swarm workflow
 * where a headless Chromium page renders into the buffer and Umbra reads
 * the resulting frame for vision/OCR pipelines.
 */

interface VirtualDisplayEntry {
  id: number;
  width: number;
  height: number;
  fps: number;
  buffer: Buffer;        // BGRA32, length = width*height*4
  createdAt: number;
  lastFrameAt: number | null;
}

let nextHandle = 1000;
const activeDisplays = new Map<number, VirtualDisplayEntry>();

function isProduction(): boolean {
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
}

function log(...args: unknown[]): void {
  if (!isProduction()) console.log(...args);
}

export async function createVirtualDisplay(
  id: number,
  width: number,
  height: number,
  fps: number
): Promise<number> {
  const handle = nextHandle++;
  const bufferSize = width * height * 4; // BGRA32
  const buffer = Buffer.alloc(bufferSize, 0);

  const entry: VirtualDisplayEntry = {
    id,
    width,
    height,
    fps,
    buffer,
    createdAt: Date.now(),
    lastFrameAt: null,
  };

  activeDisplays.set(handle, entry);
  log(`[IDDCX-Fallback] Created virtual display #${id} (${width}x${height} @${fps}fps) handle=${handle}`);

  return handle;
}

export async function destroyVirtualDisplay(handle: number): Promise<void> {
  const entry = activeDisplays.get(handle);
  if (!entry) throw new Error(`Display handle ${handle} not found`);
  activeDisplays.delete(handle);
  log(`[IDDCX-Fallback] Destroyed virtual display handle=${handle} id=${entry.id}`);
}

export async function captureDisplayBuffer(handle: number): Promise<Buffer> {
  const entry = activeDisplays.get(handle);
  if (!entry) throw new Error(`Display handle ${handle} not found`);
  // Return a copy so callers cannot mutate the live framebuffer.
  return Buffer.from(entry.buffer);
}

export async function sendFrameToDisplay(
  handle: number,
  frameData: Buffer
): Promise<void> {
  const entry = activeDisplays.get(handle);
  if (!entry) throw new Error(`Display handle ${handle} not found`);

  const expected = entry.width * entry.height * 4;
  if (frameData.length !== expected) {
    throw new Error(
      `Frame data size mismatch: expected ${expected} bytes (${entry.width}x${entry.height} BGRA32), got ${frameData.length}`
    );
  }

  frameData.copy(entry.buffer);
  entry.lastFrameAt = Date.now();
}

/**
 * Returns metadata for every active virtual display.
 * Used by VirtualDisplayManager.getActiveDisplays() and InputGuard.
 */
export function getActiveDisplays(): Array<{
  handle: number;
  id: number;
  width: number;
  height: number;
  fps: number;
  hasContent: boolean;
}> {
  return Array.from(activeDisplays.entries()).map(([handle, e]) => ({
    handle,
    id: e.id,
    width: e.width,
    height: e.height,
    fps: e.fps,
    hasContent: hasContent(e.buffer, e.width, e.height),
  }));
}

export function getActiveDisplayCount(): number {
  return activeDisplays.size;
}

/**
 * Best-effort detection of whether the framebuffer has been written to.
 * A freshly-allocated buffer is all zeros; any non-zero byte means real
 * pixels are present.
 */
function hasContent(buffer: Buffer, _width: number, _height: number): boolean {
  const maxSamples = 64;
  const step = Math.max(1, Math.floor(buffer.length / (maxSamples * 4)));
  for (let i = 0; i < buffer.length; i += step * 4) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0 || buffer[i + 2] !== 0 || buffer[i + 3] !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the primary physical display bounds. On a real IDDCX build this
 * would query EnumDisplayDevices / GetSystemMetricsForDisplay. Here we
 * fall back to a sensible default and let the caller override.
 */
export function getPrimaryDisplayBounds(): { x: number; y: number; width: number; height: number } {
  return { x: 0, y: 0, width: 1920, height: 1080 };
}