/**
 * TaskSyncBridge — broadcasts task lifecycle events to every paired device
 * over the DeviceHub mesh ("Portals"): a task started on the phone appears,
 * updates, and can be cancelled on the desktop, and vice versa.
 *
 * It subscribes to the same eventBus events AgentRuntime emits
 * (task:created / task:started / task:progress / task:completed /
 * task:failed / task:cancelled) and pushes a compact, privacy-light snapshot
 * of each task to connected devices via DeviceHub.broadcast. Receivers
 * surface it as a live task list; cancel/retry runs through the regular REST
 * API, gated by the consent gate on the executing node.
 */
import { eventBus } from '../core/EventBus';
import { getLogger } from '../core/Logger';
import { Task } from '../types';

/** Task lifecycle events AgentRuntime emits on the eventBus. */
export type TaskLifecycleEvent =
  | 'task:created'
  | 'task:started'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled';

/** Compact, privacy-light task summary broadcast to paired devices. */
export interface TaskSyncSnapshot {
  id: string;
  description?: string;
  status?: string;
  priority?: number;
  error?: string;
  progress?: number;
  completedStepCount?: number;
  totalSteps?: number;
  createdAt?: string;
}

/** Wire payload broadcast over the DeviceHub mesh (from: 'hub' is added by the hub). */
export type TaskSyncEvent = {
  /** Message type — DeviceClient routes unknown hub pushes straight to onMessage. */
  t: 'task-event';
  /** The lifecycle event that fired. */
  event: TaskLifecycleEvent;
  /** Executing node this event came from. */
  node?: 'desktop' | 'cloud';
  task: TaskSyncSnapshot;
};

export interface TaskSyncBridgeOptions {
  /** Send a message to every connected device (wire to DeviceHub.broadcast). */
  broadcast: (msg: TaskSyncEvent) => void;
  /** Optional task lookup so the payload carries a snapshot (AgentRuntime.getTask). */
  getTask?: (taskId: string) => Task | undefined;
  /** Include task descriptions in the snapshot (default true). */
  includeDescription?: boolean;
  /** Label the executing node (default 'desktop'). */
  node?: 'desktop' | 'cloud';
  /**
   * Send a message to ONE device (wire to DeviceClient.relay). Used to push
   * the full lifecycle of a remotely submitted task back to the originating
   * device, so the phone that dispatched the work tracks it live.
   */
  relayTo?: (deviceId: string, msg: TaskSyncEvent) => void;
  /**
   * True when `broadcast` already reaches the device (wire to
   * DeviceHub.isOnline). When true the direct relay is skipped — otherwise
   * the origin gets every event TWICE (once via broadcast, once via relay).
   * When unwired (tests/legacy) the relay always fires to preserve behavior.
   */
  isBroadcastCovered?: (deviceId: string) => boolean;
  /** Coalesce window for high-frequency task:progress (default 1000ms). */
  coalesceMs?: number;
}

const LIFECYCLE_EVENTS: TaskLifecycleEvent[] = [
  'task:created',
  'task:started',
  'task:progress',
  'task:completed',
  'task:failed',
  'task:cancelled',
];

export class TaskSyncBridge {
  private broadcast: (msg: TaskSyncEvent) => void;
  private getTask?: (taskId: string) => Task | undefined;
  private includeDescription: boolean;
  private node: 'desktop' | 'cloud';
  private started = false;
  private handlers: { ev: TaskLifecycleEvent; fn: (...args: unknown[]) => void }[] = [];
  private relayTo?: (deviceId: string, msg: TaskSyncEvent) => void;
  private isBroadcastCovered?: (deviceId: string) => boolean;
  private coalesceMs: number;
  /** taskId → the device that submitted it (so its lifecycle relays home). */
  private origins = new Map<string, string>();
  /** 1s coalesce state for task:progress bursts (per taskId). */
  private lastProgressSentAt = new Map<string, number>();
  private pendingProgress = new Map<string, { payload: TaskSyncEvent; timer: NodeJS.Timeout }>();

  constructor(options: TaskSyncBridgeOptions) {
    this.broadcast = options.broadcast;
    this.getTask = options.getTask;
    this.includeDescription = options.includeDescription ?? true;
    this.node = options.node ?? 'desktop';
    this.relayTo = options.relayTo;
    this.isBroadcastCovered = options.isBroadcastCovered;
    this.coalesceMs = options.coalesceMs ?? 1000;
  }

  /** Remember which device submitted a task, so its lifecycle relays home. */
  registerOrigin(taskId: string, deviceId: string): void {
    if (taskId && deviceId) this.origins.set(taskId, deviceId);
  }

  /** Forget the origin once the task reaches a terminal state. */
  forgetOrigin(taskId: string): void {
    this.origins.delete(taskId);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const ev of LIFECYCLE_EVENTS) {
      const fn = (...args: unknown[]) => void this.handleEvent(ev, args);
      this.handlers.push({ ev, fn });
      eventBus.on(ev, fn);
    }
    getLogger().info({ node: this.node }, 'Task sync bridge started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const { ev, fn } of this.handlers) eventBus.off(ev, fn);
    this.handlers = [];
    // Drop coalesced progress — a stale snapshot must not leak into the next start().
    for (const [, p] of this.pendingProgress) {
      try { clearTimeout(p.timer); } catch {}
    }
    this.pendingProgress.clear();
  }

  private handleEvent(ev: TaskLifecycleEvent, args: unknown[]): void {
    const taskId = String(args[0] ?? '');
    if (!taskId) return;

    const progress = typeof args[1] === 'number' ? args[1] : undefined;
    const extraError = typeof args[1] === 'string' ? args[1] : undefined;

    const task = this.getTask?.(taskId);
    const snapshot: TaskSyncSnapshot = task
      ? {
          id: task.id,
          description: this.includeDescription ? task.description : undefined,
          status: task.status,
          priority: task.priority,
          error: task.error,
          completedStepCount: task.completedStepCount,
          totalSteps: task.plan?.length,
          createdAt: task.createdAt?.toISOString(),
        }
      : { id: taskId };

    if (progress !== undefined) snapshot.progress = progress;
    if (extraError && !snapshot.error) snapshot.error = extraError;

    const payload: TaskSyncEvent = { t: 'task-event', event: ev, node: this.node, task: snapshot };

    // task:progress can fire per-step — coalesce bursts to 1s (leading +
    // trailing) so a fast executor doesn't spam every paired device.
    if (ev === 'task:progress') {
      this.sendProgressCoalesced(taskId, payload);
      return;
    }

    // A terminal/non-progress event supersedes any coalesced progress for
    // the same task — flush it first so receivers see progress before done.
    this.flushProgress(taskId);
    this.deliver(payload, taskId, ev);
  }

  /** Leading-edge immediate, trailing-edge coalesced progress per task. */
  private sendProgressCoalesced(taskId: string, payload: TaskSyncEvent): void {
    const now = Date.now();
    const last = this.lastProgressSentAt.get(taskId) ?? 0;
    if (now - last >= this.coalesceMs) {
      this.lastProgressSentAt.set(taskId, now);
      this.deliver(payload, taskId, 'task:progress');
      return;
    }
    // Inside the window — keep only the latest, flush when the window ends.
    const existing = this.pendingProgress.get(taskId);
    if (existing) {
      existing.payload = payload;
      return;
    }
    const delay = this.coalesceMs - (now - last);
    const timer = setTimeout(() => {
      this.pendingProgress.delete(taskId);
      this.lastProgressSentAt.set(taskId, Date.now());
      this.deliver(payload, taskId, 'task:progress');
    }, Math.max(0, delay));
    try { (timer as unknown as { unref?: () => void }).unref?.(); } catch {}
    this.pendingProgress.set(taskId, { payload, timer });
  }

  private flushProgress(taskId: string): void {
    const pending = this.pendingProgress.get(taskId);
    if (!pending) return;
    this.pendingProgress.delete(taskId);
    try { clearTimeout(pending.timer); } catch {}
    this.lastProgressSentAt.set(taskId, Date.now());
    this.deliver(pending.payload, taskId, 'task:progress');
  }

  private deliver(payload: TaskSyncEvent, taskId: string, ev: TaskLifecycleEvent): void {
    this.broadcast(payload);

    // Push the same snapshot directly to the device that submitted the task
    // — UNLESS broadcast already reaches it (locally connected via the hub),
    // in which case the relay would double-deliver every event.
    const origin = this.origins.get(taskId);
    if (origin && this.relayTo) {
      let covered = false;
      try { covered = this.isBroadcastCovered?.(origin) ?? false; } catch { covered = false; }
      if (!covered) {
        this.relayTo(origin, payload);
      }
      // Terminal states — drop the origin so the map doesn't grow unbounded.
      if (ev === 'task:completed' || ev === 'task:failed' || ev === 'task:cancelled') {
        this.origins.delete(taskId);
      }
    } else if (ev === 'task:completed' || ev === 'task:failed' || ev === 'task:cancelled') {
      this.origins.delete(taskId);
    }
  }
}
