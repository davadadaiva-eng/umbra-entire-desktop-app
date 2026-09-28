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
 * Ported from OpenMuse apps/server/src/engine/worker.ts (lease/heartbeat/
 * guard/checkpoint) into Umbra OS backend.
 *
 * Minimal viable lease for AgentRuntime: one lease per in-flight task,
 * heartbeat extends it, guard aborts stale work, checkpoint persists
 * progress. Resume-on-boot skips tasks whose lease is still live and
 * resumes stale ones from TaskStore.
 */

import { randomUUID } from 'node:crypto';

export class LostLeaseError extends Error {
  constructor() {
    super('Task was paused, cancelled or taken over by another worker');
    this.name = 'LostLeaseError';
  }
}

export interface LeaseSnapshot {
  taskId: string;
  leaseId: string;
  leaseUntil: number;
  leaseMs: number;
}

export class TaskLease {
  readonly taskId: string;
  readonly leaseId: string;
  readonly leaseMs: number;
  leaseUntil: number;
  private aborted = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(taskId: string, leaseMs = 60000) {
    this.taskId = taskId;
    this.leaseId = randomUUID();
    this.leaseMs = leaseMs;
    this.leaseUntil = Date.now() + leaseMs;
  }

  get expired(): boolean {
    return this.aborted || Date.now() > this.leaseUntil;
  }

  /** Throw LostLeaseError when this worker no longer owns the task. */
  guard(): void {
    if (this.aborted || Date.now() > this.leaseUntil) throw new LostLeaseError();
  }

  /** Apply a checkpoint patch after verifying ownership; extends the lease. */
  checkpoint<T extends object>(target: T, patch: Partial<T>): T {
    this.guard();
    Object.assign(target, patch);
    this.heartbeat();
    return target;
  }

  heartbeat(): void {
    if (this.aborted) throw new LostLeaseError();
    this.leaseUntil = Date.now() + this.leaseMs;
  }

  abort(): void {
    this.aborted = true;
    this.stopHeartbeat();
  }

  startHeartbeat(onLost?: () => void): void {
    this.stopHeartbeat();
    const interval = Math.max(10, Math.floor(this.leaseMs / 3));
    this.heartbeatTimer = setInterval(() => {
      if (this.aborted || Date.now() > this.leaseUntil) {
        this.stopHeartbeat();
        onLost?.();
        return;
      }
      this.leaseUntil = Date.now() + this.leaseMs;
    }, interval);
    if (typeof (this.heartbeatTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.heartbeatTimer as unknown as { unref: () => void }).unref();
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  release(): void {
    this.stopHeartbeat();
  }

  snapshot(): LeaseSnapshot {
    return { taskId: this.taskId, leaseId: this.leaseId, leaseUntil: this.leaseUntil, leaseMs: this.leaseMs };
  }
}

/** Tracks live leases so resume-on-boot can tell "running elsewhere" apart from "stale". */
export class TaskLeaseManager {
  private leases = new Map<string, TaskLease>();

  acquire(taskId: string, leaseMs = 60000): TaskLease {
    const existing = this.leases.get(taskId);
    if (existing && !existing.expired) {
      throw new LostLeaseError();
    }
    const lease = new TaskLease(taskId, leaseMs);
    this.leases.set(taskId, lease);
    return lease;
  }

  get(taskId: string): TaskLease | undefined {
    return this.leases.get(taskId);
  }

  release(taskId: string, leaseId?: string): boolean {
    const existing = this.leases.get(taskId);
    if (!existing) return false;
    if (leaseId && existing.leaseId !== leaseId) return false;
    existing.release();
    this.leases.delete(taskId);
    return true;
  }

  /** Clear a stale (expired/aborted) lease so boot can resume it. Returns true when resumed. */
  recoverIfStale(taskId: string): boolean {
    const existing = this.leases.get(taskId);
    if (!existing) return true;
    if (existing.expired) {
      existing.release();
      this.leases.delete(taskId);
      return true;
    }
    return false;
  }

  abort(taskId: string): void {
    this.leases.get(taskId)?.abort();
  }

  abortAll(): void {
    for (const lease of this.leases.values()) lease.abort();
    this.leases.clear();
  }
}
