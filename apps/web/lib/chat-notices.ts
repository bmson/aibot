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
  if (trimmed.startsWith("I can't claim that work was completed.")) return true;
  if (
    trimmed.startsWith('I can verify that ') &&
    trimmed.includes('so I am not claiming it completed')
  ) {
    return true;
  }
  return trimmed.startsWith('I did not create a real approval request, so nothing is waiting');
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
