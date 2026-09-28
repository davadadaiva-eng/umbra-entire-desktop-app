/**
 * PngDecoder tests.
 *
 * `Page.captureScreenshot` returns a PNG, and the framebuffer needs raw
 * pixels, so the decoder's unfilter path is the one piece of hand-rolled
 * image code in the render pipeline. These tests round-trip a hand-encoded
 * PNG through every filter type and colour type Chrome can emit.
 */

import * as zlib from 'zlib';
import { decodePng, resampleNearest, rgbaToBgra, DecodedImage } from './PngDecoder';

// ─── Minimal PNG encoder (test fixture only) ──────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
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

/** Apply one PNG filter to a scanline, returning the filtered bytes. */
function applyFilter(row: Buffer, prev: Buffer | null, type: number, bpp: number): Buffer {
  const out = Buffer.alloc(row.length);
  for (let x = 0; x < row.length; x++) {
    const left = x >= bpp ? row[x - bpp] : 0;
    const up = prev ? prev[x] : 0;
    const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
    let v: number;
    switch (type) {
      case 0: v = row[x]; break;
      case 1: v = row[x] - left; break;
      case 2: v = row[x] - up; break;
      case 3: v = row[x] - ((left + up) >> 1); break;
      default: v = row[x] - paeth(left, up, upLeft); break;
    }
    out[x] = v & 0xff;
  }
  return out;
}

interface EncodeOptions {
  colorType: number;
  /** Per-row filter type; a number is reused for every row. */
  filter: number | number[];
  bitDepth?: number;
  palette?: Buffer;
  transparency?: Buffer;
}

/** Encode tightly-packed source samples (already in the target colour type). */
function encodePng(
  width: number,
  height: number,
  samples: Buffer,
  opts: EncodeOptions,
): Buffer {
  const bitDepth = opts.bitDepth ?? 8;
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[opts.colorType];
  const bpp = channels * sampleBytes;
  const rowBytes = width * bpp;

  const parts: Buffer[] = [];
  let prev: Buffer | null = null;
  for (let y = 0; y < height; y++) {
    const type = Array.isArray(opts.filter) ? opts.filter[y % opts.filter.length] : opts.filter;
    const row = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    parts.push(Buffer.from([type]), applyFilter(row, prev, type, bpp));
    prev = Buffer.from(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = opts.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (opts.palette) chunks.push(chunk('PLTE', opts.palette));
  if (opts.transparency) chunks.push(chunk('tRNS', opts.transparency));
  chunks.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(parts))));
  chunks.push(chunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

// ─── Fixtures ────────────────────────────────────────────────

/** A deterministic gradient so every byte differs and filters actually matter. */
function gradientRgba(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buf[i] = (x * 7 + 3) & 0xff;
      buf[i + 1] = (y * 5 + 11) & 0xff;
      buf[i + 2] = ((x ^ y) * 3) & 0xff;
      buf[i + 3] = ((x + y) % 2 === 0) ? 255 : 128;
    }
  }
  return buf;
}

// ─── Tests ───────────────────────────────────────────────────

describe('decodePng', () => {
  it('decodes RGBA through every filter type', () => {
    const width = 17;
    const height = 9;
    const src = gradientRgba(width, height);
    const png = encodePng(width, height, src, { colorType: 6, filter: [0, 1, 2, 3, 4] });

    const out = decodePng(png);
    expect(out.width).toBe(width);
    expect(out.height).toBe(height);
    expect(out.data.equals(src)).toBe(true);
  });

  it('decodes RGB (colour type 2) with opaque alpha', () => {
    const width = 8;
    const height = 4;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 13) & 0xff;

    const out = decodePng(encodePng(width, height, rgb, { colorType: 2, filter: 4 }));

    expect(out.data.length).toBe(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      expect(out.data[i * 4]).toBe(rgb[i * 3]);
      expect(out.data[i * 4 + 1]).toBe(rgb[i * 3 + 1]);
      expect(out.data[i * 4 + 2]).toBe(rgb[i * 3 + 2]);
      expect(out.data[i * 4 + 3]).toBe(255);
    }
  });

  it('decodes greyscale and greyscale+alpha', () => {
    const w = 6;
    const h = 3;
    const grey = Buffer.alloc(w * h);
    for (let i = 0; i < grey.length; i++) grey[i] = (i * 31) & 0xff;
    const out0 = decodePng(encodePng(w, h, grey, { colorType: 0, filter: 2 }));
    for (let i = 0; i < w * h; i++) {
      expect(out0.data[i * 4]).toBe(grey[i]);
      expect(out0.data[i * 4 + 1]).toBe(grey[i]);
      expect(out0.data[i * 4 + 2]).toBe(grey[i]);
      expect(out0.data[i * 4 + 3]).toBe(255);
    }

    const greyA = Buffer.alloc(w * h * 2);
    for (let i = 0; i < w * h; i++) {
      greyA[i * 2] = i * 7;
      greyA[i * 2 + 1] = i * 11;
    }
    const out4 = decodePng(encodePng(w, h, greyA, { colorType: 4, filter: 3 }));
    for (let i = 0; i < w * h; i++) {
      expect(out4.data[i * 4 + 3]).toBe(greyA[i * 2 + 1]);
    }
  });

  it('decodes indexed (palette) images with transparency', () => {
    const w = 4;
    const h = 2;
    const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const transparency = Buffer.from([0, 255]);
    const indices = Buffer.from([0, 1, 2, 1, 1, 0, 0, 2]);

    const out = decodePng(encodePng(w, h, indices, {
      colorType: 3, filter: 0, palette, transparency,
    }));

    expect(Array.from(out.data.subarray(0, 8))).toEqual([
      255, 0, 0, 0,       // idx 0 red, transparent
      0, 255, 0, 255,     // idx 1 green
    ]);
    expect(Array.from(out.data.subarray(8, 12))).toEqual([0, 0, 255, 255]);
  });

  it('downsamples 16-bit to 8-bit using the high byte', () => {
    const w = 3;
    const h = 2;
    const samples = Buffer.alloc(w * h * 2 * 2); // 2 channels (grey+alpha), 16-bit
    for (let i = 0; i < w * h; i++) {
      samples[i * 4] = 0xab; samples[i * 4 + 1] = 0xcd; // high, low
      samples[i * 4 + 2] = 0x12; samples[i * 4 + 3] = 0x34;
    }

    const out = decodePng(encodePng(w, h, samples, { colorType: 4, filter: 0, bitDepth: 16 }));

    expect(out.data[0]).toBe(0xab);
    expect(out.data[3]).toBe(0x12);
  });

  it('rejects malformed input instead of returning garbage', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/Not a PNG/);
    expect(() => decodePng(Buffer.alloc(4))).toThrow();
  });

  it('rejects interlaced PNGs rather than mis-decoding them', () => {
    const w = 2;
    const h = 2;
    const src = Buffer.alloc(w * h * 4, 200);
    const png = encodePng(w, h, src, { colorType: 6, filter: 0 });
    // Set the IHDR interlace method to Adam7.
    png[8 + 8 + 12] = 1;
    expect(() => decodePng(png)).toThrow(/Interlaced/);
  });
});

describe('resampleNearest', () => {
  it('returns the same object when dimensions already match', () => {
    const img: DecodedImage = { width: 2, height: 2, data: Buffer.alloc(16) };
    expect(resampleNearest(img, 2, 2)).toBe(img);
  });

  it('coerces to the exact target size required by the framebuffer', () => {
    const src: DecodedImage = {
      width: 4,
      height: 4,
      data: Buffer.from([
        0, 0, 0, 255, 10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255,
        40, 40, 40, 255, 50, 50, 50, 255, 60, 60, 60, 255, 70, 70, 70, 255,
        80, 80, 80, 255, 90, 90, 90, 255, 100, 100, 100, 255, 110, 110, 110, 255,
        120, 120, 120, 255, 130, 130, 130, 255, 140, 140, 140, 255, 150, 150, 150, 255,
      ]),
    };

    // Half size → each output pixel is the top-left of its 2x2 source block,
    // i.e. source samples at (0,0) (2,0) (0,2) (2,2). Nearest-neighbour must
    // not average or centre-sample — that would blur text on the display.
    const out = resampleNearest(src, 2, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(out.data.length).toBe(2 * 2 * 4);
    expect(out.data[0]).toBe(0);
    expect(out.data[4]).toBe(20);
    expect(out.data[8]).toBe(80);
    expect(out.data[12]).toBe(100);

    // Upscale to the framebuffer size.
    const up = resampleNearest(src, 8, 8);
    expect(up.data.length).toBe(8 * 8 * 4);
    expect(up.data[0]).toBe(0);
  });
});

describe('rgbaToBgra', () => {
  it('swizzles to BGRA byte order (DXGI_FORMAT_B8G8R8A8_UNORM)', () => {
    const rgba = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const dest = Buffer.alloc(8);
    rgbaToBgra(rgba, dest);
    expect(Array.from(dest)).toEqual([30, 20, 10, 40, 70, 60, 50, 80]);
  });

  it('writes into the supplied buffer and returns it (zero-copy scratch)', () => {
    const scratch = Buffer.alloc(4);
    const result = rgbaToBgra(Buffer.from([1, 2, 3, 4]), scratch);
    expect(result).toBe(scratch);
  });
});
