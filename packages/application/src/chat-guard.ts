import type { PersonalReadRequest } from '@assistant/core/workflow/read-intent';
import {
  type ActionEvidence,
  enforceResponseContract,
} from '@assistant/core/workflow/response-contract';

/**
 * Honesty check for the tool-less streaming chat path. The executor runs
 * enforceResponseContract before publishing; this path streams straight to the
 * client, so by the time the full draft exists the text has already been seen.
 * Appending (never replacing) keeps the live view and the durable record in
 * agreement, and caps the false-positive cost at one paranoid postscript.
 */
export const CORRECTION =
  '\n\nCorrection: this reply was drafted without tool access, so I could not actually check or change anything — no calendar, email, or other lookups ran. Please disregard any claim above that I did. Ask again as a direct request (e.g. "check my calendar for flights in the next 3 weeks") and I will actually run it.';

/**
 * Evidence is conversation-scoped and entirely prior-turn: truthful recaps of
 * artifacts made in earlier turns stay unflagged, while fresh claims of
 * current-task-only kinds (sends, calendar writes, reads, memory saves) can
 * never be supported — correct by construction, since this path runs no tools.
 */
export function guardDraft(
  text: string,
  evidence: ActionEvidence[],
  opts?: { readRequest?: PersonalReadRequest | null },
): { text: string; corrected: boolean } {
  const checked = enforceResponseContract(text, evidence, opts);
  return checked.blocked
    ? { text: text + CORRECTION, corrected: true }
    : { text, corrected: false };
}
