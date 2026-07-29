// Server-side mappers turning DB rows into plain serializable view props for
// client components (approval cards) and shared status-chip styling.
import type { ApprovalSnapshot } from '@assistant/application/approvals';
import { moduleToolLabels } from '@assistant/modules/ui';
import { formatFriendlyDateTime, prettyJson, relativeTime } from './format';
import { Badge, type BadgeTone } from './ui';

/** Plain-serializable props for the pending-approval client card. */
export interface ApprovalField {
  label: string;
  value: string;
  /** Render in a pre-wrap block (email/SMS body, event description). */
  block?: boolean;
}

export interface PendingApprovalView {
  id: string;
  shortCode: string;
  summary: string;
  /**
   * Human-readable rendering of exactly what will happen — the email recipient
   * and body, the event time and attendees, the SMS text — so the owner does not
   * have to read raw JSON to know what they are approving. Empty for tools with
   * no structured renderer (the JSON stays available under "Review exact details").
   */
  fields: ApprovalField[];
  payloadJson: string;
  requestedLabel: string;
  expiresLabel: string;
  provenance: string;
  reason: string;
  rememberLabel: string | null;
  taskId: string;
  /** Set when the voice-rewrite pipeline failed its fact-preservation check. */
  voiceFlag: string | null;
  actionKind: 'email' | 'calendar' | 'message' | 'document' | 'browser' | 'action';
  expired: boolean;
}

const asText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.filter((v) => typeof v === 'string').join(', ')
      : value == null
        ? ''
        : String(value);

/** Turn a gated tool's payload into readable fields — what the owner is approving. */
export function approvalFields(toolName: string, payload: unknown): ApprovalField[] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const field = (label: string, value: unknown, block = false): ApprovalField | null => {
    const text = asText(value).trim();
    return text ? { label, value: text, block } : null;
  };
  let fields: (ApprovalField | null)[] = [];
  switch (toolName) {
    case 'gmail.send':
    case 'gmail.create_draft':
      fields = [field('To', p.to), field('Subject', p.subject), field('Message', p.body, true)];
      break;
    case 'calendar.create_event':
      fields = [
        field('Event', p.summary),
        field('Start', p.start),
        field('End', p.end),
        field('Attendees', p.attendees),
        field('Location', p.location),
        field('Details', p.description, true),
      ];
      break;
    case 'sms.send':
      fields = [field('To', p.to), field('Message', p.body, true)];
      break;
    case 'docs.share':
      fields = [
        field('Document', p.documentId),
        field('Share with', p.email),
        field('Access', p.role),
      ];
      break;
    default:
      fields = [];
  }
  return fields.filter((f): f is ApprovalField => f !== null);
}

function approvalReason(decision: unknown): string {
  const reason =
    decision && typeof decision === 'object' && !Array.isArray(decision)
      ? (decision as { reason?: unknown }).reason
      : undefined;
  if (typeof reason === 'string' && reason.includes('untrusted content')) {
    return 'This request used information from outside the assistant. Confirm the final action before it crosses a trust boundary.';
  }
  if (typeof reason === 'string' && reason.includes('policy')) {
    return 'A standing approval rule applies to this action.';
  }
  return 'This action can affect someone or something outside the assistant’s private workspace.';
}

function approvalActionKind(toolName: string): PendingApprovalView['actionKind'] {
  if (toolName.startsWith('gmail.')) return 'email';
  if (toolName.startsWith('calendar.')) return 'calendar';
  if (toolName.startsWith('sms.')) return 'message';
  if (toolName.startsWith('docs.') || toolName.startsWith('drive.')) return 'document';
  if (toolName.startsWith('browser.')) return 'browser';
  return 'action';
}

function rememberLabel(toolName: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (toolName === 'gmail.send') {
    const to = (payload as { to?: unknown }).to;
    const recipients = Array.isArray(to)
      ? to.filter((item): item is string => typeof item === 'string')
      : [];
    if (recipients.length === 1) {
      return `Approve and allow future direct email to ${recipients[0]}`;
    }
  }
  return null;
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

/**
 * Human labels for tool names, shared by the task-detail "What actually
 * happened" list and the chat's live activity chips. Module tools carry their
 * labels in module metadata (`ui.toolLabels`); only the platform's built-in
 * tools are named here. Falls back to the dotted name with the dot spelled as
 * a space.
 */
const platformToolLabels: Record<string, { present: string; past: string }> = {
  'web.fetch': { present: 'Reading a web page', past: 'Read a web page' },
  'memory.recall': { present: 'Recalling memory', past: 'Recalled memory' },
  'memory.save': { present: 'Saving a note to memory', past: 'Saved a note to memory' },
  'contacts.lookup': { present: 'Looking up a contact', past: 'Looked up a contact' },
  'conversations.search': { present: 'Searching past chats', past: 'Searched past chats' },
  'goals.update_progress': { present: 'Updating goal progress', past: 'Updated goal progress' },
  'mission.update': { present: 'Updating ongoing work', past: 'Updated ongoing work' },
  'task.schedule': { present: 'Scheduling follow-up work', past: 'Scheduled follow-up work' },
  'owner.notify': { present: 'Leaving you a note', past: 'Left you a note' },
};

const { present: modulePresentLabels, past: modulePastLabels } = moduleToolLabels();

/** Present tense — the chat's live activity chips ("Sending an email"). */
export function toolLabel(toolName: string): string {
  return (
    modulePresentLabels.get(toolName) ??
    platformToolLabels[toolName]?.present ??
    toolName.replaceAll('.', ' ')
  );
}

/** Past tense — the completed-task log ("Sent an email"). */
export function actionLabel(toolName: string): string {
  return (
    modulePastLabels.get(toolName) ??
    platformToolLabels[toolName]?.past ??
    toolName.replaceAll('.', ' ')
  );
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
  // Display-only: a task parked on an approval that no longer exists. Claiming
  // it is "waiting on you" is a lie — the Approvals page has nothing to show.
  stuck: 'Stuck — nothing to approve',
};

export function statusLabel(status: string): string {
  return statusLabels[status] ?? status.replaceAll('_', ' ');
}

/**
 * The status to *show* for a task. A task parked in `waiting_approval` whose
 * approval was resolved, expired, or never written is not waiting on the owner:
 * nothing about it appears on the Approvals page, so the honest label is stuck.
 * Callers pass whether a pending approval actually exists for the row.
 */
export function displayTaskStatus(status: string, hasPendingApproval: boolean): string {
  return status === 'waiting_approval' && !hasPendingApproval ? 'stuck' : status;
}

/** The voice-rewrite tool sets `voiceFlag` on its args when fact-preservation fails. */
function extractVoiceFlag(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const flag = (payload as { voiceFlag?: unknown }).voiceFlag;
  return typeof flag === 'string' && flag.trim() !== '' ? flag : null;
}

export function toPendingApprovalView(
  approval: ApprovalSnapshot,
  task: { type: string; trust: string },
  toolCall: { toolName: string; decision: unknown },
  now: Date = new Date(),
  timeZone?: string,
): PendingApprovalView {
  return {
    id: approval.id,
    shortCode: approval.shortCode,
    summary: approval.summary,
    fields: approvalFields(toolCall.toolName, approval.payload),
    payloadJson: prettyJson(approval.payload),
    requestedLabel: `requested ${relativeTime(approval.requestedAt, now)} (${formatFriendlyDateTime(approval.requestedAt, timeZone, now)})`,
    expiresLabel: `expires ${relativeTime(approval.expiresAt, now)} (${formatFriendlyDateTime(approval.expiresAt, timeZone, now)})`,
    provenance: `${taskTypeLabel(task.type)} · requested by ${trustLabel(task.trust)}`,
    reason: approvalReason(toolCall.decision),
    rememberLabel: rememberLabel(toolCall.toolName, approval.payload),
    taskId: approval.taskId,
    voiceFlag: extractVoiceFlag(approval.payload),
    actionKind: approvalActionKind(toolCall.toolName),
    expired: approval.expiresAt <= now,
  };
}

/** Task/approval/goal status → shared Badge tone. */
const statusTone: Record<string, BadgeTone> = {
  pending: 'neutral',
  running: 'blue',
  waiting_approval: 'amber',
  waiting_event: 'purple',
  waiting_budget: 'amber',
  sleeping: 'indigo',
  done: 'green',
  failed: 'red',
  needs_attention: 'orange',
  cancelled: 'muted',
  approved: 'green',
  denied: 'red',
  expired: 'muted',
  active: 'blue',
  paused: 'amber',
  abandoned: 'muted',
  stuck: 'orange',
};

export function StatusChip({ status }: { status: string }) {
  return <Badge tone={statusTone[status] ?? 'neutral'}>{statusLabel(status)}</Badge>;
}
