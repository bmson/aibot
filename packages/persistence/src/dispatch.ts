export interface WakeIntent {
  id: string;
  taskId: string;
  generation: number;
  availableAt: Date;
  status: 'pending' | 'leased' | 'delivered';
  attempts: number;
  leaseToken: string | null;
  lockedUntil: Date | null;
}
export type OutboxLease = WakeIntent & { status: 'leased'; leaseToken: string; lockedUntil: Date };
export interface DispatchOutbox {
  due(batch?: number): Promise<string[]>;
  claim(id: string): Promise<OutboxLease | null>;
  acknowledge(lease: OutboxLease): Promise<boolean>;
  retry(lease: OutboxLease): Promise<boolean>;
}
/** Resolve only after the provider has accepted this stable task/generation name. */
export interface TaskQueue {
  enqueue(taskId: string, generation: number, signal?: AbortSignal): Promise<void>;
}
