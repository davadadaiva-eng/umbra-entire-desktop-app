/**
 * Pages — document workspace store (Spaces/Pages backend, no UI).
 *
 * Ported from OpenDots `src/server/pages.ts` onto Umbra's RecordsStore
 * (owner/kind/id JSON layer over better-sqlite3) instead of raw
 * node:sqlite. Same semantics:
 *   - nested pages with parent cycle check
 *   - optimistic `expectedRevision` (409 on stale)
 *   - idempotent `createReviewed(threadId, toolCallId)` (HITL retry-safe)
 *   - per-page per-agent thread leases (`page_threads`)
 *
 * New isolated module — no routes wired yet, no behavior change.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IRecordsStore } from '../store/RecordsStore';

export const pageInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    content: z.string().max(100000).default(''),
    parentId: z.string().min(1).nullable().default(null),
  })
  .strict();

export const pagePatch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    content: z.string().max(100000).optional(),
    parentId: z.string().min(1).nullable().optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceThreadId: string | null;
}

export class PageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'PageError';
    Object.setPrototypeOf(this, PageError.prototype);
  }
}

interface PageThread {
  id: string;
  pageId: string;
  dotId: string;
  threadId: string;
  ready: boolean;
  leaseUntil: number;
}

interface PageReview {
  id: string;
  threadId: string;
  toolCallId: string;
  pageId: string;
  spaceId: string;
}

export type PagesStore = Pick<
  IRecordsStore,
  'get' | 'list' | 'put' | 'insertIfAbsent' | 'compareAndSwap'
>;

const THREAD_LEASE_MS = 60_000;

export class Pages {
  constructor(
    private readonly store: PagesStore,
    private readonly owner: string,
    private readonly spaceExists: (id: string) => boolean,
  ) {}

  private requireSpace(spaceId: string): void {
    if (!this.spaceExists(spaceId)) throw new PageError('Space not found.', 404);
  }

  async list(spaceId: string): Promise<Page[]> {
    this.requireSpace(spaceId);
    const rows = await this.store.list(this.owner, 'pages');
    return (rows as unknown as Page[])
      .filter((p) => p.spaceId === spaceId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  async get(spaceId: string, id: string): Promise<Page> {
    this.requireSpace(spaceId);
    const row = (await this.store.get(this.owner, 'pages', id)) as unknown as Page | null;
    if (!row || row.spaceId !== spaceId) {
      throw new PageError('Page not found in this Space.', 404);
    }
    return row;
  }

  private async checkParent(spaceId: string, parentId: string | null, selfId?: string): Promise<void> {
    const seen = new Set<string | undefined>([selfId]);
    let cursor = parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new PageError('A page cannot be moved into itself or a descendant.');
      }
      seen.add(cursor);
      cursor = (await this.get(spaceId, cursor)).parentId;
    }
  }

  async create(
    spaceId: string,
    input: z.input<typeof pageInput>,
    sourceThreadId: string | null = null,
  ): Promise<Page> {
    this.requireSpace(spaceId);
    const parsed = pageInput.safeParse(input);
    if (!parsed.success) {
      throw new PageError(
        'Pages require a title up to 160 characters and content up to 100,000 characters.',
      );
    }
    await this.checkParent(spaceId, parsed.data.parentId);
    const now = Date.now();
    const page: Page = {
      id: randomUUID(),
      spaceId,
      parentId: parsed.data.parentId,
      title: parsed.data.title,
      content: parsed.data.content,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      sourceThreadId,
    };
    await this.store.put(this.owner, 'pages', page as unknown as { id: string } & Record<string, unknown>);
    return page;
  }

  async reviewReceipt(threadId: string, toolCallId: string): Promise<{ pageId: string; spaceId: string } | null> {
    const row = (await this.store.get(
      this.owner,
      'page_reviews',
      `${threadId}:${toolCallId}`,
    )) as unknown as PageReview | null;
    return row ? { pageId: row.pageId, spaceId: row.spaceId } : null;
  }

  async createReviewed(
    spaceId: string,
    input: z.input<typeof pageInput>,
    threadId: string,
    toolCallId: string,
  ): Promise<Page> {
    const receiptId = `${threadId}:${toolCallId}`;
    const previous = await this.reviewReceipt(threadId, toolCallId);
    if (previous) {
      if (previous.spaceId !== spaceId) {
        throw new PageError('This review was already saved to another Space.', 409);
      }
      return this.get(spaceId, previous.pageId);
    }
    const page = await this.create(spaceId, input, threadId);
    const receipt: PageReview = { id: receiptId, threadId, toolCallId, pageId: page.id, spaceId };
    const inserted = await this.store.insertIfAbsent(
      this.owner,
      'page_reviews',
      receipt as unknown as { id: string } & Record<string, unknown>,
    );
    if (!inserted) {
      // Lost the race with a concurrent retry — return the winner's page.
      const winner = await this.reviewReceipt(threadId, toolCallId);
      if (!winner) throw new PageError('Prepared review could not be loaded.', 409);
      if (winner.spaceId !== spaceId) {
        throw new PageError('This review was already saved to another Space.', 409);
      }
      return this.get(spaceId, winner.pageId);
    }
    return page;
  }

  async update(spaceId: string, id: string, input: z.input<typeof pagePatch>): Promise<Page> {
    const parsed = pagePatch.safeParse(input);
    if (!parsed.success) {
      throw new PageError('A valid page patch and expectedRevision are required.');
    }
    const page = await this.get(spaceId, id);
    if (page.revision !== parsed.data.expectedRevision) {
      throw new PageError(
        'This page changed. Reload the latest revision before saving your draft.',
        409,
      );
    }
    const parent = parsed.data.parentId === undefined ? page.parentId : parsed.data.parentId;
    await this.checkParent(spaceId, parent, id);
    const patch: Record<string, unknown> = { updatedAt: Date.now(), revision: page.revision + 1 };
    if (parsed.data.title !== undefined) patch['title'] = parsed.data.title;
    if (parsed.data.content !== undefined) patch['content'] = parsed.data.content;
    if (parsed.data.parentId !== undefined) patch['parentId'] = parsed.data.parentId;
    const merged = await this.store.compareAndSwap(
      this.owner,
      'pages',
      id,
      { revision: parsed.data.expectedRevision },
      patch,
    );
    if (!merged) {
      throw new PageError(
        'This page changed. Reload the latest revision before saving your draft.',
        409,
      );
    }
    return merged as unknown as Page;
  }

  private threadKey(pageId: string, dotId: string): string {
    return `${pageId}:${dotId}`;
  }

  async reserveThread(pageId: string, dotId: string, threadId: string): Promise<boolean> {
    const key = this.threadKey(pageId, dotId);
    const existing = (await this.store.get(this.owner, 'page_threads', key)) as unknown as PageThread | null;
    const now = Date.now();
    if (!existing) {
      const row: PageThread = { id: key, pageId, dotId, threadId, ready: false, leaseUntil: now + THREAD_LEASE_MS };
      const inserted = await this.store.insertIfAbsent(
        this.owner,
        'page_threads',
        row as unknown as { id: string } & Record<string, unknown>,
      );
      if (inserted) return true;
      return this.reserveThread(pageId, dotId, threadId);
    }
    if (existing.ready || existing.leaseUntil > now) return false;
    const claimed = await this.store.compareAndSwap(
      this.owner,
      'page_threads',
      key,
      { leaseUntil: existing.leaseUntil },
      { leaseUntil: now + THREAD_LEASE_MS, threadId },
    );
    return claimed !== null;
  }

  async thread(pageId: string, dotId: string): Promise<{ threadId: string; ready: boolean } | undefined> {
    const row = (await this.store.get(
      this.owner,
      'page_threads',
      this.threadKey(pageId, dotId),
    )) as unknown as PageThread | null;
    return row ? { threadId: row.threadId, ready: row.ready } : undefined;
  }

  async finishThread(pageId: string, dotId: string): Promise<void> {
    const key = this.threadKey(pageId, dotId);
    const row = (await this.store.get(this.owner, 'page_threads', key)) as unknown as PageThread | null;
    if (!row) return;
    await this.store.compareAndSwap(this.owner, 'page_threads', key, { ready: false }, { ready: true });
  }

  async releaseThread(pageId: string, dotId: string): Promise<void> {
    const key = this.threadKey(pageId, dotId);
    const row = (await this.store.get(this.owner, 'page_threads', key)) as unknown as PageThread | null;
    if (!row || row.ready) return;
    await this.store.compareAndSwap(this.owner, 'page_threads', key, { ready: false }, { leaseUntil: 0 });
  }

  async forThread(threadId: string, spaceId?: string): Promise<Page | undefined> {
    const rows = (await this.store.list(this.owner, 'page_threads')) as unknown as PageThread[];
    const binding = rows.find((r) => r.threadId === threadId && r.ready);
    if (!binding) return undefined;
    const pages = (await this.store.list(this.owner, 'pages')) as unknown as Page[];
    const page = pages.find((p) => p.id === binding.pageId);
    if (!page) return undefined;
    if (spaceId && page.spaceId !== spaceId) return undefined;
    return page;
  }
}
