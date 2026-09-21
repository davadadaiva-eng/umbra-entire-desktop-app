/**
 * ImageGenerator — text-to-image via Flux Schnell.
 *
 * Supports two providers:
 *   - huggingface: synchronous Inference API call to
 *     `black-forest-labs/FLUX.1-schnell` (returns raw image bytes).
 *   - replicate:   async prediction on `black-forest-labs/flux-schnell`
 *     (create → poll → download the output URL).
 *
 * Generated images are written to the data dir and the path is returned.
 */

import * as fs from 'fs';
import * as path from 'path';
import { UmbraConfig } from '../../types';
import { getLogger } from '../Logger';
import { HttpBridge } from '../agent/HttpBridge';

export interface ImageResult {
  imagePath: string;
  provider: string;
  model: string;
  bytes: number;
  width?: number;
  height?: number;
}

const HF_DEFAULT = 'https://api-inference.huggingface.co/models';
const REPLICATE_DEFAULT = 'https://api.replicate.com/v1';

export class ImageGenerator {
  private config: UmbraConfig['image'];
  private outDir: string;

  constructor(config: UmbraConfig) {
    this.config = config.image;
    this.outDir = path.join(config.paths.dataDir, 'generated');
  }

  isEnabled(): boolean {
    return this.config.enabled && Boolean(this.config.apiKey);
  }

  async generate(prompt: string, opts: { width?: number; height?: number; steps?: number } = {}): Promise<ImageResult> {
    if (!prompt.trim()) throw new Error('prompt is required');
    if (!this.isEnabled()) throw new Error('Image generation disabled — set config.image.enabled + apiKey');

    const provider = this.config.provider;
    const model = this.config.model;
    let buffer: Buffer;
    if (provider === 'huggingface') {
      buffer = await this.huggingface(model, prompt, opts);
    } else if (provider === 'replicate') {
      buffer = await this.replicate(model, prompt, opts);
    } else {
      throw new Error(`Unsupported image provider: ${provider}`);
    }

    fs.mkdirSync(this.outDir, { recursive: true });
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
    const imagePath = path.join(this.outDir, `${slug}-${Date.now()}.png`);
    fs.writeFileSync(imagePath, buffer);

    getLogger().info({ provider, model, imagePath, bytes: buffer.length }, 'Image generated');
    return { imagePath, provider, model, bytes: buffer.length, width: opts.width, height: opts.height };
  }

  private async huggingface(
    model: string,
    prompt: string,
    opts: { width?: number; height?: number; steps?: number },
  ): Promise<Buffer> {
    const base = this.config.endpoint || HF_DEFAULT;
    const url = `${base.replace(/\/$/, '')}/${model.replace(/^\//, '')}`;
    const res = await HttpBridge.post(url, {
      inputs: prompt,
      parameters: {
        width: opts.width ?? 1024,
        height: opts.height ?? 1024,
        num_inference_steps: opts.steps ?? 4,
      },
    }, {
      'Authorization': `Bearer ${this.config.apiKey}`,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Hugging Face image error: ${res.status} ${res.text}`);
    }
    const bytes = Buffer.from(res.text, 'base64');
    if (bytes.length === 0) throw new Error('Hugging Face returned an empty image');
    return bytes;
  }

  private async replicate(
    model: string,
    prompt: string,
    opts: { width?: number; height?: number; steps?: number },
  ): Promise<Buffer> {
    const base = this.config.endpoint || REPLICATE_DEFAULT;
    const id = model.includes('/') ? model : `black-forest-labs/${model}`;

    const createRes = await HttpBridge.post(`${base}/models/${id}/predictions`, {
      input: {
        prompt,
        width: opts.width ?? 1024,
        height: opts.height ?? 1024,
        num_inference_steps: opts.steps ?? 4,
      },
    }, {
      'Authorization': `Token ${this.config.apiKey}`,
    });
    if (createRes.status < 200 || createRes.status >= 300) {
      throw new Error(`Replicate image error: ${createRes.status} ${createRes.text}`);
    }
    const prediction: any = createRes.data;

    const outputUrl = await this.awaitPrediction(base, prediction, 120_000);
    const imageRes = await HttpBridge.get(outputUrl);
    if (imageRes.status < 200 || imageRes.status >= 300) throw new Error(`Replicate output download failed: ${imageRes.status}`);
    return Buffer.from(imageRes.text, 'base64');
  }

  private async awaitPrediction(base: string, prediction: any, timeoutMs: number): Promise<string> {
    const started = Date.now();
    let current = prediction;
    while (Date.now() - started < timeoutMs) {
      if (current.status === 'succeeded') {
        const output = current.output;
        const url = Array.isArray(output) ? output[0] : typeof output === 'string' ? output : undefined;
        if (url) return url;
        throw new Error('Replicate prediction succeeded without an output URL');
      }
      if (current.status === 'failed' || current.status === 'canceled') {
        throw new Error(`Replicate prediction ${current.status}: ${current.error || 'unknown'}`);
      }
      await new Promise(r => setTimeout(r, 1500));
      const pollRes = await HttpBridge.get(`${base}/predictions/${current.id}`, undefined, {
        'Authorization': `Token ${this.config.apiKey}`,
      });
      if (pollRes.status < 200 || pollRes.status >= 300) throw new Error(`Replicate poll failed: ${pollRes.status}`);
      current = pollRes.data;
    }
    throw new Error('Replicate prediction timed out');
  }
}
