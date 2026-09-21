/**
 * VideoKit — the render-core contract: pure functions for compositing,
 * encoding decisions, and live-view frame handling shared across producers,
 * the agent desktop, and the shadow engine.
 */

export enum FrameRate {
  FLICKER = 15,
  NORMAL = 30,
  HIGH = 60,
  SMOOTH = 120,
}

export enum PixelsPerInch {
  SD = 96,
  HD = 144,
  RETINA = 288,
}

export enum VideoCodec {
  H264 = 'h264',
  H265 = 'h265',
  VP9 = 'vp9',
  AV1 = 'av1',
}

export enum RenderProfile {
  PREVIEW = 'preview',
  STANDARD = 'standard',
  STUDIO = 'studio',
  FINAL = 'final',
}

export interface VideoSettings {
  fps: FrameRate;
  ppi: PixelsPerInch;
  codec: VideoCodec;
  profile: RenderProfile;
}

export function profileFor(priority: 'power' | 'quality'): VideoSettings {
  if (priority === 'quality') {
    return { fps: FrameRate.HIGH, ppi: PixelsPerInch.RETINA, codec: VideoCodec.AV1, profile: RenderProfile.STUDIO };
  }
  return { fps: FrameRate.NORMAL, ppi: PixelsPerInch.HD, codec: VideoCodec.H264, profile: RenderProfile.PREVIEW };
}

/** Blend two RGBA buffers (source over destination). */
export function blend(src: Buffer, dst: Buffer, alpha: number): Buffer {
  if (src.length !== dst.length) throw new Error('blend: buffer length mismatch');
  const out = Buffer.alloc(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = (src[i + 3] / 255) * alpha;
    const ia = 1 - a;
    out[i] = Math.round(src[i] * a + dst[i] * ia);
    out[i + 1] = Math.round(src[i + 1] * a + dst[i + 1] * ia);
    out[i + 2] = Math.round(src[i + 2] * a + dst[i + 2] * ia);
    out[i + 3] = Math.round(255);
  }
  return out;
}

export function rgbaToBgr(frame: Buffer): Buffer {
  const out = Buffer.alloc(frame.length);
  for (let i = 0; i < frame.length; i += 4) {
    out[i] = frame[i + 2];
    out[i + 1] = frame[i + 1];
    out[i + 2] = frame[i];
    out[i + 3] = 255;
  }
  return out;
}
