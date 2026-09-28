/**
 * MIT License
 * Copyright (c) 2026 OpenMuse contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Ported from OpenMuse apps/worker/src/browser.ts (serial per-session queue
 * + persistent profile sweeper) into Umbra OS backend.
 *
 * Minimal viable manager: per-id serial queue (later calls wait for earlier
 * ones), atomic session.json persistence under a 0700 data dir, idle sweeper
 * that closes sessions untouched for idleTimeoutMs.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PersistedSession {
  id: string;
  title: string;
  url: string;
  status: 'active' | 'closed' | 'error';
  updatedAt: string;
}

export interface SessionManagerOptions {
  idleTimeoutMs?: number;
  maxProfiles?: number;
  sweepIntervalMs?: number;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) {
    throw new Error('A valid UUID session ID is required.');
  }
  return id.toLowerCase();
}

export class SessionManager {
  private sessions = new Map<string, PersistedSession>();
  private running = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();
  private sweeper?: ReturnType<typeof setInterval>;
  private readonly idleTimeoutMs: number;
  private readonly maxProfiles: number;
  private readonly sweepIntervalMs: number;

  constructor(
    private readonly dataDir: string,
    options: SessionManagerOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    this.maxProfiles = options.maxProfiles ?? 20;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.dataDir)) {
      if (!SESSION_ID.test(id)) continue;
      try {
        const stored = JSON.parse(
          await readFile(join(this.dataDir, id, 'session.json'), 'utf8'),
        ) as PersistedSession;
        this.sessions.set(id, { ...stored, id, status: 'closed' });
      } catch {
        // An incomplete first launch has no session metadata to restore.
      }
    }
  }

  /** Run fn after all earlier serial(id, …) work finishes. */
  async serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }

  markActive(id: string): void {
    this.running.set(id, Date.now());
  }

  markClosed(id: string): void {
    this.running.delete(id);
  }

  isActive(id: string): boolean {
    return this.running.has(id);
  }

  touch(id: string): void {
    if (this.running.has(id)) this.running.set(id, Date.now());
  }

  list(): PersistedSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): PersistedSession | undefined {
    return this.sessions.get(id);
  }

  checkProfileLimit(isNew: boolean): void {
    if (isNew && this.sessions.size >= this.maxProfiles) {
      throw new Error('The worker has reached its 20 saved-profile limit.');
    }
  }

  async persist(session: PersistedSession): Promise<void> {
    const dir = join(this.dataDir, validateSessionId(session.id));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, 'session.json');
    await writeFile(`${target}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
    this.sessions.set(session.id, session);
  }

  async removeProfile(id: string): Promise<void> {
    this.sessions.delete(id);
    this.running.delete(id);
    await rm(join(this.dataDir, validateSessionId(id)), { recursive: true, force: true });
  }

  /** Close idle sessions via onIdle (serialized per id). No-op when none idle. */
  startSweeper(onIdle: (id: string) => Promise<void>): void {
    this.stopSweeper();
    this.sweeper = setInterval(() => {
      for (const [id, touched] of this.running) {
        if (Date.now() - touched > this.idleTimeoutMs) {
          void this.serial(id, () => onIdle(id)).catch(() => {});
        }
      }
    }, this.sweepIntervalMs);
    if (typeof (this.sweeper as unknown as { unref?: () => void }).unref === 'function') {
      (this.sweeper as unknown as { unref: () => void }).unref();
    }
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  async close(): Promise<void> {
    this.stopSweeper();
    await Promise.allSettled([...this.queues.values()]);
  }
}
