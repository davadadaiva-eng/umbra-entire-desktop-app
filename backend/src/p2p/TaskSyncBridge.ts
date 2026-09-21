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
  /** taskId → the device that submitted it (so its lifecycle relays home). */
  private origins = new Map<string, string>();

  constructor(options: TaskSyncBridgeOptions) {
    this.broadcast = options.broadcast;
    this.getTask = options.getTask;
    this.includeDescription = options.includeDescription ?? true;
    this.node = options.node ?? 'desktop';
    this.relayTo = options.relayTo;
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
    this.broadcast(payload);

    // Push the same snapshot directly to the device that submitted the task
    // (if any), so the phone tracks its own work live, not just the broadcast.
    const origin = this.origins.get(taskId);
    if (origin && this.relayTo) {
      this.relayTo(origin, payload);
      // Terminal states — drop the origin so the map doesn't grow unbounded.
      if (ev === 'task:completed' || ev === 'task:failed' || ev === 'task:cancelled') {
        this.origins.delete(taskId);
      }
    }
  }
}
