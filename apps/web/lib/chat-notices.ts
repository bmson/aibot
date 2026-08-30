const CHAT_NOTICES = {
  'archive-active':
    'This chat still has active work. Finish, cancel, or pause it before archiving.',
} as const;

export type ApprovalOutcomeStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'missing';

export interface ApprovalSummaryOutcome {
  /** The approval's own id — stable across polls, so it keys the receipt list. */
  id: string;
  summary: string;
  status: ApprovalOutcomeStatus;
}

export interface ApprovalSummaryPart {
  type: 'approval-summary';
  purpose: string;
  approvalCount: number;
  /**
   * Live state, attached by hydrateChatApprovals in the application layer.
   * Absent on a row it could not resolve (a legacy summary whose task is
   * gone), and the card then falls back to the frozen `approvalCount`.
   */
  pendingCount?: number;
  outcomes?: ApprovalSummaryOutcome[];
}

const OUTCOME_STATUSES = new Set(['pending', 'approved', 'denied', 'expired', 'missing']);

function outcomesOf(value: unknown): ApprovalSummaryOutcome[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const outcomes: ApprovalSummaryOutcome[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { id?: unknown; summary?: unknown; status?: unknown };
    if (typeof candidate.id !== 'string' || !candidate.id) continue;
    if (typeof candidate.summary !== 'string' || typeof candidate.status !== 'string') continue;
    if (!OUTCOME_STATUSES.has(candidate.status)) continue;
    outcomes.push({
      id: candidate.id,
      summary: candidate.summary,
      status: candidate.status as ApprovalOutcomeStatus,
    });
  }
  return outcomes.length > 0 ? outcomes : undefined;
}

/** Validate the dashboard-only summary the approval notifier persists. */
export function approvalSummaryOf(parts: unknown[]): ApprovalSummaryPart | null {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const candidate = part as {
      type?: unknown;
      purpose?: unknown;
      approvalCount?: unknown;
      pendingCount?: unknown;
    };
    if (candidate.type !== 'approval-summary' || typeof candidate.purpose !== 'string') continue;
    const purpose = candidate.purpose.trim();
    if (!purpose || typeof candidate.approvalCount !== 'number') continue;
    const approvalCount = Math.trunc(candidate.approvalCount);
    if (!Number.isSafeInteger(approvalCount) || approvalCount < 1) continue;
    const pending =
      typeof candidate.pendingCount === 'number' && Number.isSafeInteger(candidate.pendingCount)
        ? Math.max(0, Math.trunc(candidate.pendingCount))
        : undefined;
    return {
      type: 'approval-summary',
      purpose,
      approvalCount,
      ...(pending === undefined ? {} : { pendingCount: pending }),
      ...(outcomesOf((part as { outcomes?: unknown }).outcomes)
        ? { outcomes: outcomesOf((part as { outcomes?: unknown }).outcomes) }
        : {}),
    };
  }
  return null;
}

export function chatNoticeMessage(code: string | undefined): string | undefined {
  return code && code in CHAT_NOTICES ? CHAT_NOTICES[code as keyof typeof CHAT_NOTICES] : undefined;
}

/**
 * Core's response contract writes deterministic, code-generated fallback copy
 * when a reply claimed more than the tool evidence supports
 * (packages/core/src/workflow/response-contract.ts). The chat renders those as
 * compact system notices instead of assistant prose. Matched on their stable
 * openings because historical messages persist the exact strings forever —
 * update alongside any core copy change, keeping the old patterns.
 */
export function isContractNotice(text: string): boolean {
  const trimmed = text.trim();
  // Pre-2026-07 copy — persisted messages keep these strings forever.
  if (trimmed.startsWith("I can't claim that work was completed.")) return true;
  if (
    trimmed.startsWith('I can verify that ') &&
    trimmed.includes('so I am not claiming it completed')
  ) {
    return true;
  }
  // Current copy (messages newer than the structured `notice` part still hit
  // this path when they streamed before the part landed).
  if (trimmed.startsWith("I couldn't verify this completed, so I'm not claiming it did.")) {
    return true;
  }
  if (
    trimmed.startsWith("I couldn't complete this because ") &&
    trimmed.endsWith('No external change was made.')
  ) {
    return true;
  }
  if (trimmed.startsWith('Completed: ') && trimmed.includes('. Still needed: ')) return true;
  if (
    trimmed.startsWith("Here's what I can confirm: ") &&
    trimmed.includes("so I'm not claiming that part")
  ) {
    return true;
  }
  if (trimmed.startsWith('I did not create a real approval request, so nothing is waiting')) {
    return true;
  }
  // 2026-08 copy. The openings above stay: a message persisted before this
  // change keeps its exact string forever, so a pattern here is only ever
  // added, never replaced. New copy uses ASCII apostrophes throughout — core
  // has historically mixed ' and ’, and a typographic one here would silently
  // fail to match.
  if (
    trimmed.startsWith("Here's where this actually stands:") &&
    trimmed.includes("I'm not claiming it did")
  ) {
    return true;
  }
  if (
    trimmed.startsWith("Here's what I can confirm: ") &&
    trimmed.includes("I'm leaving it out rather than guessing")
  ) {
    return true;
  }
  if (trimmed.startsWith("That's everything I could actually see.")) return true;
  return trimmed.startsWith('No approval request actually exists');
}

/**
 * Kinds of structured `notice` part core writes alongside the prose:
 * `response-contract` when honesty enforcement replaced a draft
 * (packages/core/src/chat.ts), and `parked` / `needs-attention` when a task
 * stopped and said so in the thread
 * (packages/core/src/workflow/executor/notices.ts). Each one is a statement
 * about the work rather than a reply, so the chat renders it as a card.
 *
 * Messages written before a marker existed carry none and keep rendering as
 * prose — nothing rewrites the past.
 */
export type NoticeKind =
  | 'response-contract'
  | 'parked'
  | 'needs-attention'
  | 'turn-failed'
  | 'retracted';

const NOTICE_KINDS = new Set<string>([
  'response-contract',
  'parked',
  'needs-attention',
  'turn-failed',
  'retracted',
]);

export interface ChatCardPresentation {
  version: 1;
  headline: string;
  summary: string;
  facts?: Array<{ label: string; value: string }>;
  detailLabel?: string;
  diagnostics?: string[];
}

function presentationOf(value: unknown): ChatCardPresentation | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.headline !== 'string' ||
    typeof candidate.summary !== 'string'
  ) {
    return null;
  }
  const headline = candidate.headline.trim();
  const summary = candidate.summary.trim();
  if (!headline || !summary) return null;
  const facts = Array.isArray(candidate.facts)
    ? candidate.facts
        .flatMap((fact) => {
          if (!fact || typeof fact !== 'object') return [];
          const entry = fact as Record<string, unknown>;
          return typeof entry.label === 'string' && typeof entry.value === 'string'
            ? [{ label: entry.label, value: entry.value }]
            : [];
        })
        .slice(0, 3)
    : undefined;
  const diagnostics = Array.isArray(candidate.diagnostics)
    ? candidate.diagnostics.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    version: 1,
    headline,
    summary,
    ...(facts?.length ? { facts } : {}),
    ...(typeof candidate.detailLabel === 'string' ? { detailLabel: candidate.detailLabel } : {}),
    ...(diagnostics?.length ? { diagnostics } : {}),
  };
}

/** Compact hierarchy attached by core/application, if this client understands it. */
export function noticePresentationOf(parts: unknown[]): ChatCardPresentation | null {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const candidate = part as Record<string, unknown>;
    if (candidate.type !== 'notice') continue;
    const presentation = presentationOf(candidate.presentation);
    if (presentation) return presentation;
  }
  return null;
}

export interface RetractionNoticePart {
  type: 'notice';
  notice: 'retracted';
  originalText: string;
  reason: string;
  repairId?: string;
}

export function retractionNoticeOf(parts: unknown[]): RetractionNoticePart | null {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const candidate = part as Record<string, unknown>;
    if (candidate.type !== 'notice' || candidate.notice !== 'retracted') continue;
    if (typeof candidate.originalText !== 'string' || typeof candidate.reason !== 'string') {
      continue;
    }
    return {
      type: 'notice',
      notice: 'retracted',
      originalText: candidate.originalText,
      reason: candidate.reason,
      ...(typeof candidate.repairId === 'string' ? { repairId: candidate.repairId } : {}),
    };
  }
  return null;
}

export function noticeKindOf(parts: unknown[]): NoticeKind | null {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if ((part as { type?: unknown }).type !== 'notice') continue;
    const notice = (part as { notice?: unknown }).notice;
    if (typeof notice === 'string' && NOTICE_KINDS.has(notice)) return notice as NoticeKind;
  }
  return null;
}

/**
 * Decisions written before parts went card-only carry the same content twice:
 * once as a prose text part, and once as the structured part the card is built
 * from (step-loop.ts and notices.ts in core). New writes carry no prose part —
 * the prose lives only in the row's `text` column for model history — so this
 * filter exists for historical rows: where the card carries the same
 * information, the duplicated prose is suppressed and a decision reads as one
 * object rather than a paragraph followed by a restatement of itself.
 *
 * Matched on their stable openings, because historical messages persist the
 * exact strings forever — the patterns only ever need to cover the past.
 */
export function isDecisionProseNotice(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('This needs your approval before I act:') ||
    trimmed.startsWith('I need your permission to raise this task’s spending limit')
  );
}

/**
 * The tool-less streaming path's honesty guard marks a reply that claimed work
 * it could not have run (guardDraft in packages/application/src/chat-guard.ts).
 * The marker arrives live as a `data-off-course` stream part and persists as a
 * `notice` part on the message (assistantMessageParts in core), and the chat
 * renders the reply with the "answered without checking" card under it rather
 * than a baked-in confession.
 */
export function isOffCourse(parts: unknown[]): boolean {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const candidate = part as { type?: unknown; notice?: unknown };
    if (candidate.type === 'data-off-course') return true;
    if (candidate.type === 'notice' && candidate.notice === 'off-course') return true;
  }
  return false;
}

/**
 * The response contract's replacement for a flagged draft, carried on the live
 * `data-off-course` part. The draft itself had already streamed token by token
 * and cannot be un-sent, so the marker brings the text that was actually
 * persisted and the reply re-renders as that.
 *
 * Only ever present on the streamed copy. The persisted twin needs nothing:
 * its own text parts already hold the replacement. Keeping the two identical
 * is what lets `retireProvisionalReplies` recognise them as one reply.
 */
export function offCourseReplacement(parts: unknown[]): string | null {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const candidate = part as { type?: unknown; data?: unknown };
    if (candidate.type !== 'data-off-course') continue;
    const text = (candidate.data as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return null;
}

export type TurnFailureReason = 'model' | 'budget' | 'empty';

/**
 * Why a `turn-failed` notice happened, carried on the part itself
 * (finishTask in core). Drives the card's action: a budget stop links to the
 * Costs page, the rest offer a retry.
 */
export function turnFailedReason(parts: unknown[]): TurnFailureReason | null {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const candidate = part as { type?: unknown; notice?: unknown; reason?: unknown };
    if (candidate.type !== 'notice' || candidate.notice !== 'turn-failed') continue;
    return candidate.reason === 'budget' || candidate.reason === 'empty'
      ? candidate.reason
      : 'model';
  }
  return null;
}
