import EventEmitter from 'eventemitter3';

export type UmbraEvents = {
  'app:ready': () => void;
  'app:shutdown': () => void;
  'task:created': (taskId: string) => void;
  'task:started': (taskId: string) => void;
  'task:progress': (taskId: string, step: number) => void;
  'task:completed': (taskId: string, result: unknown) => void;
  'task:failed': (taskId: string, error: string) => void;
  'task:cancelled': (taskId: string) => void;
  'task:activity': (taskId: string, activity: { title: string; detail: string; status: string; timestamp: Date }) => void;
  'task:input_requested': (taskId: string, input: { question: string; options?: string[]; inputId: string }) => void;
  'task:input_received': (taskId: string, input: { inputId: string; answer: string }) => void;
  'swarm:allocated': (swarmId: number) => void;
  'swarm:freed': (swarmId: number) => void;
  'display:created': (id: number) => void;
  'display:destroyed': (id: number) => void;
  'healing:recovered': (taskId: string) => void;
  'healing:failed': (taskId: string, error: string) => void;
  'recall:macro-detected': (pattern: string) => void;
  'audio:gesture': (gesture: 'clap' | 'snap') => void;
  'config:changed': () => void;
  'knowledge:updated': (nodeId: string) => void;
  'vault:entry': (entryId: string) => void;
  'overlay:toggle': () => void;
  'overlay:command': (command: string) => void;
  'stream:started': () => void;
  'stream:stopped': () => void;
  'screen:update': (payload: Record<string, unknown>) => void;
  'screen:cursor': (payload: { x: number; y: number }) => void;
  'meeting:order': (payload: Record<string, unknown>) => void;
  'meeting:transcript': (payload: Record<string, unknown>) => void;
  'chrome:telemetry': (payload: Record<string, unknown>) => void;
  'chrome:connector-saved': (payload: { provider: string; connectorId: string; connectorName: string; capabilities: string[]; sessionStored: boolean }) => void;
  'chrome:connector-disconnected': (payload: { connectorId: string }) => void;
};

export class EventBus {
  private emitter = new EventEmitter<UmbraEvents>();

  on<K extends keyof UmbraEvents>(event: K, fn: UmbraEvents[K]): void {
    this.emitter.on(event, fn as any);
  }

  off<K extends keyof UmbraEvents>(event: K, fn: UmbraEvents[K]): void {
    this.emitter.off(event, fn as any);
  }

  emit<K extends keyof UmbraEvents>(event: K, ...args: Parameters<UmbraEvents[K]>): void {
    this.emitter.emit(event, ...(args as any));
  }

  once<K extends keyof UmbraEvents>(event: K, fn: UmbraEvents[K]): void {
    this.emitter.once(event, fn as any);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

export const eventBus = new EventBus();
