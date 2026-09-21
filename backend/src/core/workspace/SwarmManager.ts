import { SwarmPriority, SwarmTaskType } from '../../types';
import { VirtualDisplayManager } from './VirtualDisplayManager';
import { InputGuard } from './InputGuard';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';

export interface SwarmSlot {
  id: number;
  displayId: number;
  priority: SwarmPriority;
  taskType: SwarmTaskType;
  status: 'idle' | 'busy' | 'allocating';
  currentTaskId?: string;
  cpuUsage: number;
  gpuUsage: number;
  allocatedAt: Date;
}

export interface SwarmTask {
  id: string;
  action: string;
  params: Record<string, unknown>;
  startedAt?: Date;
}

export class SwarmManager {
  private slots: Map<number, SwarmSlot> = new Map();
  private displayManager: VirtualDisplayManager;
  private inputGuard: InputGuard;
  private maxSlots: number;
  private cpuLimit: number;
  private gpuLimit: number;
  private taskQueue: { task: SwarmTask; priority: SwarmPriority; taskType: SwarmTaskType; callback: (slotId: number) => void }[] = [];

  constructor(
    displayManager: VirtualDisplayManager,
    inputGuard: InputGuard,
    config: { maxSlots: number; cpuLimit: number; gpuLimit: number }
  ) {
    this.displayManager = displayManager;
    this.inputGuard = inputGuard;
    this.maxSlots = config.maxSlots;
    this.cpuLimit = config.cpuLimit;
    this.gpuLimit = config.gpuLimit;
  }

  async initialize(): Promise<void> {
    for (let i = 0; i < this.maxSlots; i++) {
      const display = await this.displayManager.create();
      const region = {
        x: 1920 + (i * 400),
        y: 0,
        width: display.width,
        height: display.height,
      };

      this.inputGuard.registerVirtualDisplay(display.id, region);

      const slot: SwarmSlot = {
        id: i,
        displayId: display.id,
        priority: 'normal',
        taskType: 'generic',
        status: 'idle',
        cpuUsage: 0,
        gpuUsage: 0,
        allocatedAt: new Date(),
      };

      this.slots.set(i, slot);
    }

    getLogger().info({ count: this.maxSlots }, 'Swarm initialized');
  }

  async acquireSwarm(taskType: SwarmTaskType, priority: SwarmPriority): Promise<number> {
    const available = this.findAvailableSlot(taskType);
    if (available !== -1) {
      const slot = this.slots.get(available)!;
      slot.status = 'allocating';
      slot.taskType = taskType;
      slot.priority = priority;
      slot.allocatedAt = new Date();
      eventBus.emit('swarm:allocated', available);
      return available;
    }

    return new Promise((resolve) => {
      this.taskQueue.push({
        task: { id: `queue-${Date.now()}`, action: '', params: {} },
        priority,
        taskType,
        callback: resolve,
      });
      this.taskQueue.sort((a, b) => this.priorityWeight(b.priority) - this.priorityWeight(a.priority));
    });
  }

  async assignTask(slotId: number, task: SwarmTask): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`Swarm slot ${slotId} not found`);
    if (slot.status !== 'allocating' && slot.status !== 'idle') throw new Error(`Swarm slot ${slotId} is not available`);

    slot.status = 'busy';
    slot.currentTaskId = task.id;
    task.startedAt = new Date();

    const simulatedMs = 500 + Math.random() * 2000;
    await new Promise(r => setTimeout(r, simulatedMs));

    getLogger().info({ slotId, taskId: task.id, action: task.action }, 'Swarm task completed');
  }

  releaseSwarm(slotId: number): void {
    const slot = this.slots.get(slotId);
    if (!slot) return;

    slot.status = 'idle';
    slot.currentTaskId = undefined;
    slot.cpuUsage = 0;
    slot.gpuUsage = 0;
    eventBus.emit('swarm:freed', slotId);

    this.processQueue();
  }

  async shutdown(): Promise<void> {
    this.taskQueue = [];
    for (const slot of this.slots.values()) {
      this.inputGuard.unregisterVirtualDisplay(slot.displayId);
      await this.displayManager.destroy(slot.displayId);
    }
    this.slots.clear();
  }

  getSlot(slotId: number): SwarmSlot | undefined {
    return this.slots.get(slotId);
  }

  getStatus(): { busy: number; idle: number; total: number; queueLength: number } {
    const slots = Array.from(this.slots.values());
    return {
      busy: slots.filter(s => s.status === 'busy').length,
      idle: slots.filter(s => s.status === 'idle').length,
      total: slots.length,
      queueLength: this.taskQueue.length,
    };
  }

  updateResourceLimits(cpu: number, gpu: number): void {
    this.cpuLimit = cpu;
    this.gpuLimit = gpu;
  }

  private findAvailableSlot(_taskType: SwarmTaskType): number {
    for (const [id, slot] of this.slots) {
      if (slot.status === 'idle') return id;
    }

    const busySlots = Array.from(this.slots.values())
      .filter(s => s.status === 'busy')
      .sort((a, b) => this.priorityWeight(a.priority) - this.priorityWeight(b.priority));

    for (const slot of busySlots) {
      if (this.priorityWeight(slot.priority) < this.priorityWeight('normal')) {
        return slot.id;
      }
    }

    return -1;
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0) return;
    const next = this.taskQueue.shift()!;
    this.acquireSwarm(next.taskType, next.priority).then(next.callback);
  }

  private priorityWeight(p: SwarmPriority): number {
    switch (p) {
      case 'high': return 3;
      case 'normal': return 2;
      case 'low': return 1;
    }
  }
}
