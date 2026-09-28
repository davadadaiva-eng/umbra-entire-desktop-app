import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { getLogger } from '../Logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CarouselAspect = '1:1' | '4:5' | '9:16';

export interface CarouselSlide {
  id: string;
  html: string;
  order: number;
  note?: string;
}

export interface CarouselData {
  id: string;
  name: string;
  aspectRatio: CarouselAspect;
  slides: CarouselSlide[];
  createdAt: string;
  updatedAt: string;
}

export interface BrandConfig {
  name: string;
  colors: { primary: string; secondary: string; accent: string; background: string; surface: string };
  fonts: { heading: string; body: string };
  logo?: string;
  styleKeywords: string;
}

export interface ExportResult {
  pngBuffers: Array<{ name: string; buffer: Buffer }>;
  carousel: CarouselData;
}

export interface CarruselStatus {
  running: boolean;
  url: string;
  port: number;
  carousels: number;
}

// ---------------------------------------------------------------------------
// OpenCarruselBridge
// ---------------------------------------------------------------------------

export class OpenCarruselBridge {
  private process: ChildProcess | null = null;
  private repoDir: string;
  private port: number;
  private baseUrl: string;

  constructor(repoDir: string, port: number = 3100) {
    this.repoDir = repoDir;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  isInstalled(): boolean {
    return fs.existsSync(path.join(this.repoDir, 'package.json'))
      && fs.existsSync(path.join(this.repoDir, 'node_modules', 'next'));
  }

  /** Convenience alias for `isInstalled()` — used by the UI status endpoint. */
  get available(): boolean {
    return this.isInstalled();
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  // ── Server lifecycle ───────────────────────────────────────

  async start(): Promise<boolean> {
    if (this.isRunning()) return true;
    if (!this.isInstalled()) {
       getLogger().warn('OpenCarruselBridge: not installed — Instagram carousel designer unavailable. ' +
        'Install with: cd backend && git clone https://github.com/umbra-os/open-carrusel.git external/open-carrusel && cd external/open-carrusel && npm install && npm run dev');
      return false;
    }

    const bin = process.platform === 'win32'
      ? path.join(this.repoDir, 'node_modules', '.bin', 'next.cmd')
      : path.join(this.repoDir, 'node_modules', '.bin', 'next');

    if (!fs.existsSync(bin)) {
       getLogger().warn('OpenCarruselBridge: next binary missing — install deps first. Run: cd external/open-carrusel && npm install');
      return false;
    }

    return new Promise(resolve => {
      this.process = spawn(bin, ['dev', '--port', String(this.port)], {
        cwd: this.repoDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        windowsHide: true,
      });

      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      this.process.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes('localhost:' + this.port) || text.includes('127.0.0.1:' + this.port)) {
          getLogger().info({ port: this.port }, 'OpenCarruselBridge: server ready');
          done(true);
        }
      });

      this.process.stderr!.on('data', (chunk: Buffer) => {
        getLogger().debug({ msg: chunk.toString().trim() }, 'OpenCarruselBridge: stderr');
      });

      this.process.on('exit', (code) => {
        if (!settled) done(false);
        this.process = null;
        getLogger().warn({ code }, 'OpenCarruselBridge: server exited');
      });

      this.process.on('error', (err) => {
        if (!settled) done(false);
        this.process = null;
        getLogger().error({ err: err.message }, 'OpenCarruselBridge: spawn failed');
      });

      setTimeout(() => done(false), 30000);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    try { proc.kill('SIGTERM'); } catch { }
    await new Promise<void>(resolve => {
      proc.once('exit', () => resolve());
      setTimeout(() => resolve(), 5000);
    });
  }

  // ── HTTP helpers ───────────────────────────────────────────

  private async apiGet<T>(pathname: string): Promise<T> {
    const text = await this.httpRequest('GET', pathname);
    return JSON.parse(text) as T;
  }

  private async apiPost<T>(pathname: string, body?: unknown): Promise<T> {
    const text = await this.httpRequest('POST', pathname, body);
    return JSON.parse(text) as T;
  }

  private async apiPostBuffer(pathname: string, body?: unknown): Promise<Buffer> {
    return this.httpRequestBuffer('POST', pathname, body);
  }

  private httpRequest(method: string, pathname: string, body?: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, this.baseUrl);
      const req = http.request(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        timeout: 60000,
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private httpRequestBuffer(method: string, pathname: string, body?: unknown): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, this.baseUrl);
      const req = http.request(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        timeout: 120000,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ── API: Carousels ─────────────────────────────────────────

  async createCarousel(name: string, aspectRatio: CarouselAspect = '4:5'): Promise<CarouselData> {
    const result = await this.apiPost<{ carousel: CarouselData }>('/api/carousels', { name, aspectRatio });
    return result.carousel;
  }

  async getCarousel(id: string): Promise<CarouselData> {
    const result = await this.apiGet<{ carousel: CarouselData }>(`/api/carousels/${id}`);
    return result.carousel;
  }

  async listCarousels(): Promise<CarouselData[]> {
    const result = await this.apiGet<{ carousels: CarouselData[] }>('/api/carousels');
    return result.carousels;
  }

  /** Add a slide (raw HTML body content) to a carousel. */
  async addSlide(carouselId: string, html: string, note?: string): Promise<CarouselSlide> {
    const result = await this.apiPost<{ slide: CarouselSlide }>(`/api/carousels/${carouselId}/slides`, {
      html,
      note: note || '',
    });
    return result.slide;
  }

  /** Replace a slide's HTML. */
  async updateSlide(carouselId: string, slideId: string, html: string): Promise<CarouselSlide> {
    const result = await this.apiPost<{ slide: CarouselSlide }>(`/api/carousels/${carouselId}/slides/${slideId}`, { html });
    return result.slide;
  }

  /** Undo the last change to a slide (version history). */
  async undoSlide(carouselId: string, slideId: string): Promise<CarouselSlide> {
    const result = await this.apiPost<{ slide: CarouselSlide }>(`/api/carousels/${carouselId}/slides/${slideId}/undo`, {});
    return result.slide;
  }

  /** Delete a carousel. */
  async deleteCarousel(id: string): Promise<void> {
    await this.httpRequest('DELETE', `/api/carousels/${id}`);
  }

  // ── API: Chat (Claude-designed slide generation) ────────────

  /** Send a chat message to the Claude agent and stream the response.
   *  Returns the full accumulated text. */
  async chat(message: string, carouselId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/chat', this.baseUrl);
      const body = JSON.stringify({ message, carouselId });
      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      }, res => {
        let fullText = '';
        res.on('data', chunk => {
          const text = chunk.toString();
          // SSE format: "data: {...}\n\n"
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.text) fullText += parsed.text;
              } catch { /* partial chunk */ }
            }
          }
        });
        res.on('end', () => resolve(fullText));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('chat timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── API: Export ────────────────────────────────────────────

  /** Export all slides as PNGs and return the ZIP buffer. */
  async exportZip(carouselId: string): Promise<Buffer> {
    return this.apiPostBuffer(`/api/carousels/${carouselId}/export`);
  }

  // ── API: Brand ─────────────────────────────────────────────

  async getBrand(): Promise<BrandConfig> {
    const result = await this.apiGet<{ brand: BrandConfig }>('/api/brand');
    return result.brand;
  }

  async updateBrand(patch: Partial<BrandConfig>): Promise<BrandConfig> {
    const result = await this.apiPost<{ brand: BrandConfig }>('/api/brand', patch);
    return result.brand;
  }

  // ── API: Duplicate ─────────────────────────────────────────

  async duplicateCarousel(id: string): Promise<CarouselData> {
    const result = await this.apiPost<{ carousel: CarouselData }>(`/api/carousels/${id}/duplicate`);
    return result.carousel;
  }

  // ── Status ─────────────────────────────────────────────────

  async getStatus(): Promise<CarruselStatus> {
    let carousels = 0;
    if (this.isRunning()) {
      try {
        const list = await this.listCarousels();
        carousels = list.length;
      } catch { /* server may still be starting */ }
    }
    return {
      running: this.isRunning(),
      url: this.baseUrl,
      port: this.port,
      carousels,
    };
  }
}