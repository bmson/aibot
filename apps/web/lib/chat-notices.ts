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
    trimmed.startsWith("Here's what I can confirm: ") &&
    trimmed.includes("so I'm not claiming that part")
  ) {
    return true;
  }
  return trimmed.startsWith('I did not create a real approval request, so nothing is waiting');
}

/** Structured marker written by core when the response contract replaced a draft. */
export function hasContractNoticePart(parts: unknown[]): boolean {
  return parts.some(
    (part) =>
      Boolean(part) &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'notice' &&
      (part as { notice?: unknown }).notice === 'response-contract',
  );
}

/**
 * The executor posts a prose list of the same approvals that arrive as
 * structured `approval` parts (step-loop.ts / approvals.ts in core). When those
 * parts are present the grouped card carries the exact same information, so the
 * duplicated prose is suppressed in the chat render. The persisted text is
 * untouched — core's isSimulatedApprovalNotice depends on it.
 */
export function isApprovalProseNotice(text: string): boolean {
  return text.trim().startsWith('This needs your approval before I act:');
}
