const CHAT_NOTICES = {
  'archive-active':
    'This chat still has active work. Finish, cancel, or pause it before archiving.',
} as const;

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
export type NoticeKind = 'response-contract' | 'parked' | 'needs-attention' | 'turn-failed';

const NOTICE_KINDS = new Set<string>([
  'response-contract',
  'parked',
  'needs-attention',
  'turn-failed',
]);

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
 * The executor writes each decision twice: once as prose, and once as the
 * structured part the card is built from (step-loop.ts and notices.ts in core).
 * Where the card carries the same information — and better — the duplicated
 * prose is suppressed in the chat render, so a decision reads as one object
 * rather than a paragraph followed by a restatement of itself. Only the render
 * is affected; the persisted text is untouched, and core's
 * isSimulatedApprovalNotice depends on it.
 *
 * Matched on their stable openings, because historical messages persist the
 * exact strings forever — update alongside any core copy change.
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
 * `notice` part on the message (assistantMessageParts in core) — the text is
 * left as drafted either way, so the chat renders the reply with the
 * "answered without checking" card under it rather than a baked-in confession.
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
