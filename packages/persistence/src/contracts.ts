import type { Records } from './records.js';

/** Interfaces describe atomic domain operations, never SDK queries or transaction objects. */
export type SpendSource =
  | 'model'
  | 'embedding'
  | 'twilio_sms'
  | 'twilio_voice_min'
  | 'cloud_run_job_sec'
  | 'storage_gb_month'
  | 'external_api';

export interface CostTotals {
  dailySpentUsd: number;
  monthlySpentUsd: number;
  heldUsd: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  softPct: number;
}

export interface CostEventInput {
  source: SpendSource;
  usd: number;
  taskId?: string | null;
  toolCallId?: string | null;
  quantity?: number;
  unit?: string;
  unitPriceUsd?: number;
  description?: string;
  reservationId?: string;
  addToTaskSpend?: boolean;
}

export interface ReserveCostInput {
  source: SpendSource;
  estimatedUsd: number;
  taskId?: string;
  description?: string;
  critical?: boolean;
  /** Stable across a caller's transport retries. Reusing it for other work is rejected. */
  operationId?: string;
}

export type ReserveOutcome =
  | { ok: true; reservationId: string }
  | { ok: false; reason: string; resumeAt: Date };

export interface ReservationActual {
  usd: number;
  quantity?: number;
  unit?: string;
  unitPriceUsd?: number;
  toolCallId?: string;
  description?: string;
}

export interface CostRepository {
  readonly kind: 'cost-repository';
  getRate(key: string): Promise<{ unit: string; unitPriceUsd: number } | null>;
  totals(): Promise<CostTotals>;
  reserve(input: ReserveCostInput): Promise<ReserveOutcome>;
  record(input: CostEventInput): Promise<void>;
  reconcile(reservationId: string, actual: ReservationActual): Promise<void>;
  release(reservationId: string): Promise<void>;
  releaseStale(olderThanMinutes?: number, batch?: number): Promise<number>;
}

export interface ReminderCancellation {
  cancelled: boolean;
  text?: string;
  queuedTasksCancelled?: number;
}

export interface ReminderRepository {
  readonly kind: 'reminder-repository';
  cancel(agentId: string, reminderId: string, now?: Date): Promise<ReminderCancellation>;
}

export function nextUtcDailyReset(from = new Date()): Date {
  const next = new Date(from);
  next.setUTCHours(24, 5, 0, 0);
  return next;
}

export function nextUtcMonthlyReset(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 5));
}

/** Timestamp enforces expiry; the opaque token fences replaced leases. Null supports existing PostgreSQL leases during upgrade. */
export type TaskLease = Records['tasks'] & { lockedUntil: Date };
export interface TaskCheckpoint {
  progress?: string;
  progressPercent?: number | null;
  nextAction?: string;
  lastReflectedAt?: Date;
}
export interface TaskLeaseRepository {
  readonly kind: 'task-lease-repository';
  claim(taskId: string): Promise<TaskLease | null>;
  /** On success updates the supplied lease, matching existing executor semantics. */
  renew(task: TaskLease): Promise<boolean>;
  checkpoint(task: TaskLease, state: unknown, extra?: TaskCheckpoint): Promise<boolean>;
}
export interface AppendMessageInput {
  conversationId: string;
  taskId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  origin: 'owner' | 'known_contact' | 'unknown' | 'web' | 'assistant' | 'system';
  parts: unknown[];
  text: string;
  channelMessageId?: string;
}
export interface MessageRepository {
  readonly kind: 'message-repository';
  /** Duplicate channel deliveries return undefined, as in the existing API. */
  append(input: AppendMessageInput): Promise<Records['messages'] | undefined>;
}
