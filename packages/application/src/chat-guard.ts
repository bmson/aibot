import type { PersonalReadRequest } from '@assistant/core/workflow/read-intent';
import {
  type ActionEvidence,
  enforceResponseContract,
} from '@assistant/core/workflow/response-contract';

/**
 * Honesty check for the tool-less streaming chat path. The executor runs
 * enforceResponseContract before publishing; this path streams straight to the
 * client, so by the time the full draft exists the text has already been seen.
 *
 * A flagged draft is marked, not edited: the reply persists with an
 * `off-course` notice part and the chat renders a compact card under it —
 * the claim stays visible, its trust state is unmistakable, and the card
 * offers to rerun the request through the real executor. That beats a long
 * confession paragraph baked into the message text forever.
 */
export function guardDraft(
  text: string,
  evidence: ActionEvidence[],
  opts?: { readRequest?: PersonalReadRequest | null },
): { corrected: boolean; text: string } {
  const checked = enforceResponseContract(text, evidence, {
    ...opts,
    urlCorpus: JSON.stringify(evidence),
  });
  return { corrected: checked.blocked || checked.text !== text, text: checked.text };
}
