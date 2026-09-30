import { createHash } from 'node:crypto';
/** Durable repair ledger. Provider and coding credentials never enter these records. */
export const REPAIR_STATUSES = [
  'reported',
  'investigating',
  'fixing',
  'testing',
  'pr_open',
  'merged',
  'monitoring',
  'resolved',
  'blocked',
  'failed',
  'dismissed',
] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];
export const ACTIVE_REPAIR_STATUSES: readonly RepairStatus[] = [
  'investigating',
  'fixing',
  'testing',
  'pr_open',
];
export interface RepairDetails {
  source: 'feedback' | 'failure' | 'proposal';
  symptomKey?: string;
  parentIssueId?: string;
  sourceTaskId?: string;
  conversationId?: string;
  proposalId?: string;
  title: string;
  summary: string;
  diagnosis?: string;
  category?: 'bug' | 'configuration' | 'provider' | 'answer' | 'unknown';
  targetPaths?: string[];
  reproduction?: string;
  acceptance?: string;
  branch?: string;
  runId?: number;
  runUrl?: string;
  prNumber?: number;
  prUrl?: string;
  mergeSha?: string;
  dispatchedAt?: string;
  monitoringAt?: string;
  lastError?: string;
  notifiedStatus?: RepairStatus;
  history: Array<{ status: RepairStatus; at: string; detail: string }>;
}
export interface RepairIssue {
  id: string;
  agentId: string;
  fingerprint: string;
  status: RepairStatus;
  version: number;
  data: RepairDetails;
  createdAt: Date;
  updatedAt: Date;
}
export interface RepairReport {
  fingerprint: string;
  source: RepairDetails['source'];
  symptomKey?: string;
  parentIssueId?: string;
  sourceTaskId?: string;
  conversationId?: string;
  proposalId?: string;
  title: string;
  summary: string;
}
export interface SelfRepairRepository {
  report(agentId: string, input: RepairReport): Promise<RepairIssue>;
  list(agentId: string): Promise<RepairIssue[]>;
  /** Atomic per-owner claim; active work and the daily dispatch allowance are checked under a lock. */
  claim(agentId: string, now: Date, dailyLimit: number): Promise<RepairIssue | null>;
  /** Compare-and-swap: stale workers and duplicate sweeps cannot overwrite newer state. */
  update(
    issue: RepairIssue,
    status: RepairStatus,
    patch: Partial<RepairDetails>,
    now: Date,
  ): Promise<RepairIssue | null>;
  failures(
    agentId: string,
    since: Date,
  ): Promise<Array<{ taskId: string; title: string; symptomKey?: string; observedAt?: string }>>;
}
export function repairTransition(
  issue: RepairIssue,
  status: RepairStatus,
  patch: Partial<RepairDetails>,
  now: Date,
): RepairIssue {
  return {
    ...issue,
    status,
    version: issue.version + 1,
    updatedAt: now,
    data: {
      ...issue.data,
      ...patch,
      history:
        status === issue.status
          ? issue.data.history
          : [
              ...issue.data.history,
              { status, at: now.toISOString(), detail: patch.lastError ?? patch.diagnosis ?? '' },
            ].slice(-30),
    },
  };
}

/** Group recurring failures without storing raw error text in the grouping key. */
export function repairFailureKey(title: string, state: unknown): string {
  const error =
    state && typeof state === 'object' && 'lastError' in state ? String(state.lastError) : title;
  const signature = error
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27,}\b/g, '[id]')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
  return createHash('sha256').update(signature).digest('hex');
}
