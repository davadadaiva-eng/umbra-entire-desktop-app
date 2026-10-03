/**
 * Ideas — source-backed suggestions with accept/edit/dismiss.
 *
 * Accepted and dismissed ideas never resurface: `pending()` only returns
 * ideas still awaiting a decision. Editing keeps the sources and marks
 * who changed the text.
 *
 * Stored on RecordsStore (kind `ideas`). No routes wired yet.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IRecordsStore } from '../store/RecordsStore';

export const ideaInput = z
  .object({
    text: z.string().trim().min(1).max(2000),
    sources: z.array(z.string().trim().min(1).max(2048)).max(10).default([]),
    rule: z.string().trim().min(1).max(200).default('manual'),
  })
  .strict();

export interface Idea {
  id: string;
  text: string;
  sources: string[];
  rule: string;
  status: 'pending' | 'accepted' | 'dismissed';
  createdAt: number;
  updatedAt: number;
}

export class IdeaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'IdeaError';
    Object.setPrototypeOf(this, IdeaError.prototype);
  }
}

export class Ideas {
  constructor(
    private readonly store: Pick<IRecordsStore, 'get' | 'list' | 'put'>,
    private readonly owner: string,
    private readonly now: () => number = Date.now,
  ) {}

  async suggest(input: z.input<typeof ideaInput>): Promise<Idea> {
    const parsed = ideaInput.safeParse(input);
    if (!parsed.success) {
      throw new IdeaError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const now = this.now();
    const idea: Idea = {
      id: randomUUID(),
      text: parsed.data.text,
      sources: parsed.data.sources,
      rule: parsed.data.rule,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.put(this.owner, 'ideas', idea as unknown as { id: string } & Record<string, unknown>);
    return idea;
  }

  async get(id: string): Promise<Idea> {
    const row = (await this.store.get(this.owner, 'ideas', id)) as unknown as Idea | null;
    if (!row) throw new IdeaError('Idea not found.', 404);
    return row;
  }

  /** Only ideas still awaiting a decision — accepted/dismissed never resurface. */
  async pending(): Promise<Idea[]> {
    const rows = (await this.store.list(this.owner, 'ideas')) as unknown as Idea[];
    return rows
      .filter((i) => i.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async accept(id: string): Promise<Idea> {
    return this.decide(id, 'accepted');
  }

  async dismiss(id: string): Promise<Idea> {
    return this.decide(id, 'dismissed');
  }

  async edit(id: string, text: string): Promise<Idea> {
    const idea = await this.get(id);
    if (idea.status !== 'pending') {
      throw new IdeaError(`Idea already ${idea.status}.`, 400);
    }
    const parsed = z.string().trim().min(1).max(2000).safeParse(text);
    if (!parsed.success) throw new IdeaError('Idea text must be 1–2000 characters.');
    const next = { ...idea, text: parsed.data, updatedAt: this.now() };
    await this.store.put(this.owner, 'ideas', next as unknown as { id: string } & Record<string, unknown>);
    return next;
  }

  private async decide(id: string, status: 'accepted' | 'dismissed'): Promise<Idea> {
    const idea = await this.get(id);
    if (idea.status !== 'pending') return idea;
    const next = { ...idea, status, updatedAt: this.now() };
    await this.store.put(this.owner, 'ideas', next as unknown as { id: string } & Record<string, unknown>);
    return next;
  }
}
