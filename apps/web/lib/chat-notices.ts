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
export type NoticeKind = 'response-contract' | 'parked' | 'needs-attention';

const NOTICE_KINDS = new Set<string>(['response-contract', 'parked', 'needs-attention']);

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
 * The placeholder the chat route streams back when a turn was handed to the
 * executor (acceptedStreamResponse in packages/application/src/chat-turn.ts —
 * keep the two in step). It exists only to give the AI SDK a valid completed
 * message and is never persisted, so it can never meet a durable twin: left in
 * the log it would sit below every message that lands after it. The presence
 * row says the same thing, better, so the log drops it.
 */
export function isAsyncAcknowledgement(text: string): boolean {
  return text.trim().startsWith('Got it — I’m working on this now.');
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
