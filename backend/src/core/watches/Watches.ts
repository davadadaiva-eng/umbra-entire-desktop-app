/**
 * Watches — recurring public-page checks with deduplicated alerts.
 *
 * A watch polls one URL on an interval and fires an alert only when its
 * condition is newly met:
 *   - changed:    page content hash differs from the last observation
 *   - contains:   page newly contains the needle text
 *   - priceBelow: first number found in the page dropped below threshold
 *
 * Alerts are deduplicated by content hash (same event fires once).
 * Failures back off exponentially (interval * 2^failures, capped at 24h).
 *
 * Stored on RecordsStore (kinds `watches`, `alerts`). No routes wired yet.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IRecordsStore } from '../store/RecordsStore';

export const watchInput = z
  .object({
    url: z.string().trim().min(1).max(2048),
    kind: z.enum(['changed', 'contains', 'priceBelow']),
    needle: z.string().trim().min(1).max(500).optional(),
    threshold: z.number().finite().optional(),
    intervalSeconds: z.number().int().min(60).max(31536000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'contains' && !v.needle) {
      ctx.addIssue({ code: 'custom', message: 'needle is required for contains watches', path: ['needle'] });
    }
    if (v.kind === 'priceBelow' && v.threshold === undefined) {
      ctx.addIssue({ code: 'custom', message: 'threshold is required for priceBelow watches', path: ['threshold'] });
    }
    if (!/^https?:\/\//i.test(v.url)) {
      ctx.addIssue({ code: 'custom', message: 'url must be an http(s) URL', path: ['url'] });
    }
  });

export interface Watch {
  id: string;
  url: string;
  kind: 'changed' | 'contains' | 'priceBelow';
  needle?: string;
  threshold?: number;
  intervalSeconds: number;
  nextRunAt: number;
  lastHash: string | null;
  status: 'active' | 'paused';
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface WatchAlert {
  id: string;
  watchId: string;
  url: string;
  excerpt: string;
  createdAt: number;
}

export class WatchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'WatchError';
    Object.setPrototypeOf(this, WatchError.prototype);
  }
}

const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export function backoffMs(intervalSeconds: number, failures: number): number {
  return Math.min(intervalSeconds * 1000 * 2 ** Math.max(0, failures), MAX_BACKOFF_MS);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function firstNumber(content: string): number | null {
  const m = content.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export class Watches {
  constructor(
    private readonly store: Pick<IRecordsStore, 'get' | 'list' | 'put' | 'insertIfAbsent'>,
    private readonly owner: string,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: z.input<typeof watchInput>): Promise<Watch> {
    const parsed = watchInput.safeParse(input);
    if (!parsed.success) {
      throw new WatchError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const now = this.now();
    const watch: Watch = {
      id: randomUUID(),
      url: parsed.data.url,
      kind: parsed.data.kind,
      needle: parsed.data.needle,
      threshold: parsed.data.threshold,
      intervalSeconds: parsed.data.intervalSeconds,
      nextRunAt: now,
      lastHash: null,
      status: 'active',
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.put(this.owner, 'watches', watch as unknown as { id: string } & Record<string, unknown>);
    return watch;
  }

  async get(id: string): Promise<Watch> {
    const row = (await this.store.get(this.owner, 'watches', id)) as unknown as Watch | null;
    if (!row) throw new WatchError('Watch not found.', 404);
    return row;
  }

  async due(now: number = this.now()): Promise<Watch[]> {
    const rows = (await this.store.list(this.owner, 'watches')) as unknown as Watch[];
    return rows
      .filter((w) => w.status === 'active' && w.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  async pause(id: string): Promise<Watch> {
    const watch = await this.get(id);
    const next = { ...watch, status: 'paused' as const, updatedAt: this.now() };
    await this.store.put(this.owner, 'watches', next as unknown as { id: string } & Record<string, unknown>);
    return next;
  }

  async resume(id: string): Promise<Watch> {
    const watch = await this.get(id);
    const next = { ...watch, status: 'active' as const, nextRunAt: this.now(), updatedAt: this.now() };
    await this.store.put(this.owner, 'watches', next as unknown as { id: string } & Record<string, unknown>);
    return next;
  }

  /**
   * Record one poll result. Returns whether the condition fired and the
   * alert (when a genuinely new event occurred — repeats are suppressed).
   */
  async observe(
    id: string,
    content: string,
  ): Promise<{ fired: boolean; alert: WatchAlert | null }> {
    const watch = await this.get(id);
    const now = this.now();
    const hash = contentHash(`${watch.kind}:${content}`);
    let fired = false;
    if (watch.kind === 'changed') {
      fired = watch.lastHash !== null && watch.lastHash !== hash;
    } else if (watch.kind === 'contains') {
      const has = content.includes(watch.needle ?? '');
      const before = watch.lastHash;
      // Fire only on the transition absent -> present.
      fired = has && before !== `present:${watch.needle}`;
    } else {
      const price = firstNumber(content);
      fired =
        price !== null &&
        watch.threshold !== undefined &&
        price < watch.threshold &&
        watch.lastHash !== `below:${price}`;
    }
    let alert: WatchAlert | null = null;
    if (fired) {
      const candidate: WatchAlert = {
        id: contentHash(`${watch.id}:${hash}`),
        watchId: watch.id,
        url: watch.url,
        excerpt: content.slice(0, 320),
        createdAt: now,
      };
      const inserted = await this.store.insertIfAbsent(
        this.owner,
        'alerts',
        candidate as unknown as { id: string } & Record<string, unknown>,
      );
      alert = (inserted as unknown as WatchAlert | null) ?? null;
    }
    const marker =
      watch.kind === 'contains'
        ? content.includes(watch.needle ?? '')
          ? `present:${watch.needle}`
          : `absent`
        : watch.kind === 'priceBelow'
          ? (() => {
              const price = firstNumber(content);
              return price !== null && watch.threshold !== undefined && price < watch.threshold
                ? `below:${price}`
                : hash;
            })()
          : hash;
    await this.store.put(
      this.owner,
      'watches',
      {
        ...watch,
        lastHash: marker,
        consecutiveFailures: 0,
        nextRunAt: now + watch.intervalSeconds * 1000,
        updatedAt: now,
      } as unknown as { id: string } & Record<string, unknown>,
    );
    return { fired, alert };
  }

  /** Record a failed poll; the next run backs off exponentially. */
  async fail(id: string): Promise<Watch> {
    const watch = await this.get(id);
    const now = this.now();
    const failures = watch.consecutiveFailures + 1;
    const next = {
      ...watch,
      consecutiveFailures: failures,
      nextRunAt: now + backoffMs(watch.intervalSeconds, failures),
      updatedAt: now,
    };
    await this.store.put(this.owner, 'watches', next as unknown as { id: string } & Record<string, unknown>);
    return next;
  }

  async alerts(): Promise<WatchAlert[]> {
    const rows = (await this.store.list(this.owner, 'alerts')) as unknown as WatchAlert[];
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }
}
