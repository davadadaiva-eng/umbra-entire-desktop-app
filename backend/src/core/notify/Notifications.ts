/**
 * Notifications — durable inbox that survives restarts.
 *
 * `notify()` appends; `unread()` lists newest-first; `markRead()` flips one;
 * `reconcile()` is the restart hook (returns pending count so boot can log
 * it — entries are already durable, nothing to repair).
 *
 * Stored on RecordsStore (kind `notifications`). No routes wired yet.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IRecordsStore } from '../store/RecordsStore';

export const notificationInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(2000).optional(),
    sourceLink: z.string().trim().max(2048).optional(),
  })
  .strict();

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  sourceLink: string;
  read: boolean;
  createdAt: number;
}

export class NotificationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'NotificationError';
    Object.setPrototypeOf(this, NotificationError.prototype);
  }
}

export class Notifications {
  constructor(
    private readonly store: Pick<IRecordsStore, 'get' | 'list' | 'put'>,
    private readonly owner: string,
    private readonly now: () => number = Date.now,
  ) {}

  async notify(input: z.input<typeof notificationInput>): Promise<AppNotification> {
    const parsed = notificationInput.safeParse(input);
    if (!parsed.success) {
      throw new NotificationError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const note: AppNotification = {
      id: randomUUID(),
      title: parsed.data.title,
      body: parsed.data.body ?? '',
      sourceLink: parsed.data.sourceLink ?? '',
      read: false,
      createdAt: this.now(),
    };
    await this.store.put(this.owner, 'notifications', note as unknown as { id: string } & Record<string, unknown>);
    return note;
  }

  async unread(): Promise<AppNotification[]> {
    const rows = (await this.store.list(this.owner, 'notifications')) as unknown as AppNotification[];
    return rows.filter((n) => !n.read).sort((a, b) => b.createdAt - a.createdAt);
  }

  async markRead(id: string): Promise<AppNotification> {
    const row = (await this.store.get(this.owner, 'notifications', id)) as unknown as AppNotification | null;
    if (!row) throw new NotificationError('Notification not found.', 404);
    if (row.read) return row;
    const next = { ...row };
    next.read = true;
    await this.store.put(this.owner, 'notifications', next as unknown as { id: string } & Record<string, unknown>);
    return next;
  }

  /** Restart hook: count pending so boot can log it. Entries need no repair. */
  async reconcile(): Promise<{ pending: number }> {
    return { pending: (await this.unread()).length };
  }
}
