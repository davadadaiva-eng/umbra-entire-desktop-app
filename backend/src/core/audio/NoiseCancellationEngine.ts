import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';

export interface AudioBuffer {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  timestamp: number;
}

export interface GestureEvent {
  type: 'clap' | 'snap';
  confidence: number;
  timestamp: number;
  amplitude: number;
}

export class NoiseCancellationEngine {
  private enabled: boolean = false;
  private referenceBuffer: AudioBuffer[] = [];
  private gestureCooldownMs: number = 2000;
  private lastGestureTime: number = 0;
  private streamActive: boolean = false;

  // DSP state
  private fftBufferSize: number = 4096;
  private transientHistory: { amplitude: number; timestamp: number }[] = [];
  private sampleRate: number = 48000;

  constructor(cooldownMs: number = 2000) {
    this.gestureCooldownMs = cooldownMs;
  }

  start(): void {
    this.enabled = true;
    this.streamActive = true;
    this.lastGestureTime = 0;
    getLogger().info('Noise cancellation engine started');
  }

  stop(): void {
    this.enabled = false;
    this.streamActive = false;
    getLogger().info('Noise cancellation engine stopped');
  }

  feedSystemAudio(buffer: AudioBuffer): void {
    if (!this.enabled) return;

    this.referenceBuffer.push(buffer);
    if (this.referenceBuffer.length > 10) {
      this.referenceBuffer.shift();
    }
  }

  feedMicrophoneAudio(buffer: AudioBuffer): GestureEvent | null {
    if (!this.enabled) return null;

    const cleanedBuffer = this.cancelReferenceAudio(buffer);
    const gesture = this.detectGesture(cleanedBuffer);

    return gesture;
  }

  private cancelReferenceAudio(micBuffer: AudioBuffer): AudioBuffer {
    if (this.referenceBuffer.length === 0) return micBuffer;

    const latestRef = this.referenceBuffer[this.referenceBuffer.length - 1];
    const minLength = Math.min(micBuffer.samples.length, latestRef.samples.length);

    const cleaned = new Float32Array(micBuffer.samples);
    for (let i = 0; i < minLength; i++) {
      cleaned[i] = micBuffer.samples[i] - (latestRef.samples[i] * 0.95);
    }

    return {
      samples: cleaned,
      sampleRate: micBuffer.sampleRate,
      channels: micBuffer.channels,
      timestamp: micBuffer.timestamp,
    };
  }

  private detectGesture(buffer: AudioBuffer): GestureEvent | null {
    const now = Date.now();
    if (now - this.lastGestureTime < this.gestureCooldownMs) return null;

    const { peak, spectralEnergy } = this.analyzeFrame(buffer);

    this.transientHistory.push({ amplitude: peak, timestamp: now });
    if (this.transientHistory.length > 100) {
      this.transientHistory.shift();
    }

    const baseline = this.computeBaseline();
    const threshold = baseline * 3.5;

    if (peak > threshold && peak > 0.3) {
      const isClap = this.detectClap(peak, baseline);
      const isSnap = this.detectSnap(spectralEnergy, peak);

      if (isClap) {
        this.lastGestureTime = now;
        const event: GestureEvent = { type: 'clap', confidence: Math.min(100, (peak / baseline) * 50), timestamp: now, amplitude: peak };
        eventBus.emit('audio:gesture', 'clap');
        getLogger().info('Double clap detected');
        return event;
      }

      if (isSnap) {
        this.lastGestureTime = now;
        const event: GestureEvent = { type: 'snap', confidence: Math.min(100, spectralEnergy * 200), timestamp: now, amplitude: peak };
        eventBus.emit('audio:gesture', 'snap');
        getLogger().info('Finger snap detected');
        return event;
      }
    }

    return null;
  }

  private analyzeFrame(buffer: AudioBuffer): { rms: number; peak: number; spectralEnergy: number } {
    const samples = buffer.samples;

    let sumSquares = 0;
    let peak = 0;

    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      sumSquares += abs * abs;
      if (abs > peak) peak = abs;
    }

    const rms = Math.sqrt(sumSquares / samples.length);
    const spectralEnergy = this.computeSpectralEnergy(samples);

    return { rms, peak, spectralEnergy };
  }

  private computeSpectralEnergy(samples: Float32Array): number {
    const fftSize = 1024;
    let energy2kTo5k = 0;
    let totalEnergy = 0;

    for (let i = 0; i < samples.length - fftSize; i += fftSize / 2) {
      const segment = samples.slice(i, i + fftSize);

      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);
      for (let j = 0; j < fftSize; j++) {
        re[j] = segment[j];
      }

      this.simpleFFT(re, im);

      for (let j = 0; j < fftSize / 2; j++) {
        const magnitude = Math.sqrt(re[j] * re[j] + im[j] * im[j]);
        const freq = (j * this.sampleRate) / fftSize;

        totalEnergy += magnitude;

        if (freq >= 2000 && freq <= 5000) {
          energy2kTo5k += magnitude;
        }
      }
    }

    return totalEnergy > 0 ? energy2kTo5k / totalEnergy : 0;
  }

  private simpleFFT(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    if (n <= 1) return;

    // Bit-reversal permutation
    const bits = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let v = i, r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (v & 1);
        v >>= 1;
      }
      rev[i] = r;
    }
    for (let i = 0; i < n; i++) {
      if (rev[i] > i) {
        [re[i], re[rev[i]]] = [re[rev[i]], re[i]];
        [im[i], im[rev[i]]] = [im[rev[i]], im[i]];
      }
    }

    // Cooley-Tukey iterative butterfly
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const theta = -2 * Math.PI / size;
      const wRe = Math.cos(theta);
      const wIm = Math.sin(theta);
      for (let i = 0; i < n; i += size) {
        let curRe = 1, curIm = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j;
          const b = a + half;
          const tRe = curRe * re[b] - curIm * im[b];
          const tIm = curRe * im[b] + curIm * re[b];
          re[b] = re[a] - tRe;
          im[b] = im[a] - tIm;
          re[a] += tRe;
          im[a] += tIm;
          const newCurRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = newCurRe;
        }
      }
    }
  }

  private detectClap(peak: number, baseline: number): boolean {
    if (this.transientHistory.length < 5) return false;

    let transientCount = 0;
    const now = Date.now();
    const windowMs = 500;

    for (let i = this.transientHistory.length - 1; i >= 0; i--) {
      const entry = this.transientHistory[i];
      if (now - entry.timestamp > windowMs) break;
      if (entry.amplitude > baseline * 2.5) transientCount++;
    }

    return transientCount >= 2 && peak > 0.4;
  }

  private detectSnap(spectralEnergy: number, peak: number): boolean {
    return spectralEnergy > 0.15 && peak > 0.25 && peak < 0.6;
  }

  private computeBaseline(): number {
    if (this.transientHistory.length < 10) return 0.05;

    const sorted = this.transientHistory
      .slice(-30)
      .map(e => e.amplitude)
      .sort((a, b) => a - b);

    const mid = Math.floor(sorted.length / 2);
    return sorted[mid] || 0.05;
  }

  setCooldown(ms: number): void {
    this.gestureCooldownMs = ms;
  }
}
