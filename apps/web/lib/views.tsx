// Server-side mappers turning DB rows into plain serializable view props for
// client components (approval cards) and shared status-chip styling.
import type { ApprovalRow, TaskRow } from '@assistant/db';
import { formatDateTime, prettyJson, relativeTime } from '@/lib/format';

/** Plain-serializable props for the pending-approval client card. */
export interface PendingApprovalView {
  id: string;
  shortCode: string;
  summary: string;
  payloadJson: string;
  requestedLabel: string;
  expiresLabel: string;
  provenance: string;
  taskId: string;
  /** Set when the voice-rewrite pipeline failed its fact-preservation check. */
  voiceFlag: string | null;
}

/** Internal workflow names are useful to engineers, not to the person using the assistant. */
const taskTypeLabels: Record<string, string> = {
  chat_turn: 'Chat request',
  adhoc: 'One-time work',
  scheduled: 'Scheduled check',
  mission: 'Ongoing work',
  email_triage: 'Inbox request',
  sms_turn: 'Text conversation',
  import: 'Import',
};

export function taskTypeLabel(type: string): string {
  return taskTypeLabels[type] ?? type.replaceAll('_', ' ');
}

const trustLabels: Record<string, string> = {
  owner: 'You',
  assistant: 'Assistant',
  known: 'Known contact',
  unknown: 'Outside contact',
};

export function trustLabel(trust: string): string {
  return trustLabels[trust] ?? trust.replaceAll('_', ' ');
}

const statusLabels: Record<string, string> = {
  pending: 'Queued',
  running: 'Working',
  waiting_approval: 'Needs your approval',
  waiting_event: 'Waiting for a reply',
  waiting_budget: 'Paused for budget',
  sleeping: 'Next check scheduled',
  done: 'Completed',
  failed: 'Could not finish',
  needs_attention: 'Needs attention',
  cancelled: 'Cancelled',
  approved: 'Approved',
  denied: 'Declined',
  expired: 'Expired',
  active: 'Active',
  paused: 'Paused',
  abandoned: 'Stopped',
};

export function statusLabel(status: string): string {
  return statusLabels[status] ?? status.replaceAll('_', ' ');
}

/** The voice-rewrite tool sets `voiceFlag` on its args when fact-preservation fails. */
function extractVoiceFlag(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const flag = (payload as { voiceFlag?: unknown }).voiceFlag;
  return typeof flag === 'string' && flag.trim() !== '' ? flag : null;
}

export function toPendingApprovalView(
  approval: ApprovalRow,
  task: Pick<TaskRow, 'type' | 'trust'>,
  now: Date = new Date(),
): PendingApprovalView {
  return {
    id: approval.id,
    shortCode: approval.shortCode,
    summary: approval.summary,
    payloadJson: prettyJson(approval.payload),
    requestedLabel: `requested ${relativeTime(approval.requestedAt, now)} (${formatDateTime(approval.requestedAt)})`,
    expiresLabel: `expires ${relativeTime(approval.expiresAt, now)} (${formatDateTime(approval.expiresAt)})`,
    provenance: `${taskTypeLabel(task.type)} · requested by ${trustLabel(task.trust)}`,
    taskId: approval.taskId,
    voiceFlag: extractVoiceFlag(approval.payload),
  };
}

/** Tailwind classes for task/approval status chips, dark-mode friendly. */
export const statusChipClasses: Record<string, string> = {
  pending: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  waiting_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  waiting_event: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  waiting_budget: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  sleeping: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  done: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  needs_attention: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
  // approval statuses
  approved: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  denied: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  expired: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
  // goal statuses ('done' shared with tasks above)
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  abandoned: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

export function StatusChip({ status }: { status: string }) {
  const classes =
    statusChipClasses[status] ?? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${classes}`}
    >
      {statusLabel(status)}
    </span>
  );
}
