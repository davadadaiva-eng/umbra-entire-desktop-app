/**
 * Minimal PNG decoder — pure Node (`zlib` only, no new dependencies).
 *
 * Chrome's `Page.captureScreenshot` returns a base64 PNG. The virtual display
 * framebuffer needs raw pixels, so we decode the PNG here. Only the subset
 * Chrome actually emits is supported: 8/16-bit, non-interlaced, colour
 * types 0 (grey), 2 (RGB), 4 (grey+alpha) and 6 (RGBA). Adam7 interlacing is
 * rejected rather than silently producing garbage.
 *
 * Output is always tightly-packed 8-bit RGBA.
 */

import * as zlib from 'zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface DecodedImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel, length = width * height * 4. */
  data: Buffer;
}

/** Bytes-per-pixel in the source image for each supported PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode a PNG buffer into RGBA.
 * Throws on unsupported variants so callers can fall back to the last good frame
 * instead of pushing a corrupt one to the display.
 */
export function decodePng(png: Buffer): DecodedImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG buffer');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new Error(`Truncated PNG chunk ${type}`);

    switch (type) {
      case 'IHDR':
        width = png.readUInt32BE(dataStart);
        height = png.readUInt32BE(dataStart + 4);
        bitDepth = png[dataStart + 8];
        colorType = png[dataStart + 9];
        interlace = png[dataStart + 12];
        break;
      case 'PLTE':
        palette = png.subarray(dataStart, dataEnd);
        break;
      case 'tRNS':
        transparency = png.subarray(dataStart, dataEnd);
        break;
      case 'IDAT':
        idat.push(png.subarray(dataStart, dataEnd));
        break;
      case 'IEND':
        offset = png.length;
        break;
      default:
        break;
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4; // skip the 4-byte CRC
  }

  if (width <= 0 || height <= 0) throw new Error('PNG has no valid IHDR');
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);

  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`Unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('Indexed PNG without PLTE');

  if (idat.length === 0) throw new Error('PNG has no IDAT data');

  // 16-bit sources are stored big-endian; only the high byte is kept.
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  const bytesPerPixel = channels * sampleBytes;
  const bytesPerRow = width * bytesPerPixel;

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const expected = (bytesPerRow + 1) * height;
  if (inflated.length < expected) {
    throw new Error(`PNG data too short: ${inflated.length} < ${expected}`);
  }

  const raw = unfilter(inflated, height, bytesPerPixel, bytesPerRow);
  return toRgba(raw, {
    width,
    height,
    channels,
    sampleBytes,
    colorType,
    palette,
    transparency,
  });
}

/**
 * Reverse the per-scanline PNG filters in place-ish, returning a tightly
 * packed buffer of `bytesPerRow * height` bytes with no filter bytes.
 */
function unfilter(
  inflated: Buffer,
  height: number,
  bytesPerPixel: number,
  bytesPerRow: number,
): Buffer {
  const out = Buffer.allocUnsafe(bytesPerRow * height);
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const rowStart = y * bytesPerRow;
    const prevStart = rowStart - bytesPerRow;
    const hasPrev = y > 0;

    switch (filter) {
      case 0: // None
        inflated.copy(out, rowStart, src, src + bytesPerRow);
        break;

      case 1: // Sub — each byte minus the byte `bpp` to its left
        for (let x = 0; x < bytesPerRow; x++) {
          const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0;
          out[rowStart + x] = (inflated[src + x] + left) & 0xff;
        }
        break;

      case 2: // Up — each byte minus the byte directly above
        if (hasPrev) {
          for (let x = 0; x < bytesPerRow; x++) {
            out[rowStart + x] = (inflated[src + x] + out[prevStart + x]) & 0xff;
          }
        } else {
          inflated.copy(out, rowStart, src, src + bytesPerRow);
        }
        break;

      case 3: // Average — minus the floor of (left + above) / 2
        for (let x = 0; x < bytesPerRow; x++) {
          const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0;
          const up = hasPrev ? out[prevStart + x] : 0;
          out[rowStart + x] = (inflated[src + x] + ((left + up) >> 1)) & 0xff;
        }
        break;

      case 4: // Paeth
        for (let x = 0; x < bytesPerRow; x++) {
          const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0;
          const up = hasPrev ? out[prevStart + x] : 0;
          const upLeft = hasPrev && x >= bytesPerPixel ? out[prevStart + x - bytesPerPixel] : 0;
          out[rowStart + x] = (inflated[src + x] + paeth(left, up, upLeft)) & 0xff;
        }
        break;

      default:
        throw new Error(`Unknown PNG filter type ${filter} on row ${y}`);
    }

    src += bytesPerRow;
  }

  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface ExpandContext {
  width: number;
  height: number;
  channels: number;
  sampleBytes: number;
  colorType: number;
  palette: Buffer | null;
  transparency: Buffer | null;
}

function toRgba(raw: Buffer, ctx: ExpandContext): DecodedImage {
  const { width, height, channels, sampleBytes, colorType, palette, transparency } = ctx;
  const rgba = Buffer.allocUnsafe(width * height * 4);
  const rowBytes = width * channels * sampleBytes;
  const step = sampleBytes; // 16-bit → keep the high byte

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    let d = y * width * 4;

    for (let x = 0; x < width; x++) {
      const s = rowStart + x * channels * sampleBytes;

      switch (colorType) {
        case 0: { // greyscale
          const g = raw[s];
          rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = 255;
          break;
        }
        case 2: { // RGB
          rgba[d] = raw[s];
          rgba[d + 1] = raw[s + step];
          rgba[d + 2] = raw[s + step * 2];
          rgba[d + 3] = 255;
          break;
        }
        case 3: { // indexed
          const idx = raw[s];
          const p = idx * 3;
          rgba[d] = palette ? palette[p] : 0;
          rgba[d + 1] = palette ? palette[p + 1] : 0;
          rgba[d + 2] = palette ? palette[p + 2] : 0;
          rgba[d + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
          break;
        }
        case 4: { // greyscale + alpha
          const g = raw[s];
          rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g;
          rgba[d + 3] = raw[s + step];
          break;
        }
        default: { // 6 — RGBA
          rgba[d] = raw[s];
          rgba[d + 1] = raw[s + step];
          rgba[d + 2] = raw[s + step * 2];
          rgba[d + 3] = raw[s + step * 3];
          break;
        }
      }

      d += 4;
    }
  }

  return { width, height, data: rgba };
}

/**
 * Nearest-neighbour resample to an exact target size.
 *
 * The virtual framebuffer has a fixed byte size (`width * height * 4`) that
 * `sendFrameToDisplay` validates, so a screenshot whose dimensions drift from
 * the display's must be coerced rather than rejected. Rounding rather than
 * truncating the source ratio keeps a 16:9 page from shearing when the
 * emulated viewport is nudged by a device-pixel-ratio.
 */
export function resampleNearest(
  src: DecodedImage,
  targetWidth: number,
  targetHeight: number,
): DecodedImage {
  if (src.width === targetWidth && src.height === targetHeight) return src;

  const out = Buffer.allocUnsafe(targetWidth * targetHeight * 4);
  const xRatio = src.width / targetWidth;
  const yRatio = src.height / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    let sy = Math.floor(y * yRatio);
    if (sy >= src.height) sy = src.height - 1;
    const srcRow = sy * src.width * 4;
    let d = y * targetWidth * 4;

    for (let x = 0; x < targetWidth; x++) {
      let sx = Math.floor(x * xRatio);
      if (sx >= src.width) sx = src.width - 1;
      const s = srcRow + sx * 4;
      out[d] = src.data[s];
      out[d + 1] = src.data[s + 1];
      out[d + 2] = src.data[s + 2];
      out[d + 3] = src.data[s + 3];
      d += 4;
    }
  }

  return { width: targetWidth, height: targetHeight, data: out };
}

/**
 * Convert RGBA to the BGRA byte order the Windows framebuffer expects
 * (D3D/DXGI `DXGI_FORMAT_B8G8R8A8_UNORM`).
 * Writes into `dest` so the hot path can reuse one allocation per display.
 */
export function rgbaToBgra(rgba: Buffer, dest: Buffer): Buffer {
  const len = rgba.length;
  for (let i = 0; i < len; i += 4) {
    dest[i] = rgba[i + 2];
    dest[i + 1] = rgba[i + 1];
    dest[i + 2] = rgba[i];
    dest[i + 3] = rgba[i + 3];
  }
  return dest;
}
