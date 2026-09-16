import type { MemorySupersedeRepository, SupersedeFact } from '@assistant/persistence';
import { z } from 'zod';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { pickWinner } from './consolidation.js';

/**
 * Write-time supersession: a correction takes effect on the turn it is made.
 *
 * `memory.save` is an append. Until now the only thing that ever retired a
 * stale fact was the nightly consolidation, and that sweep reviews at most
 * `MAX_WINDOWS_PER_RUN` entities per run — so the owner could say "I've moved
 * to Reykjavik", watch the assistant agree, and still be told their old
 * address the next morning, because both facts were live in the same recall
 * window. The owner had already done the only thing that should be asked of
 * them; the delay was ours.
 *
 * This runs one bounded check on the way in: take the handful of live facts
 * about the same subject that are near enough in embedding space to be about
 * the same attribute, ask a cheap model call which of them the new fact
 * *cannot coexist with*, and retire those. Two properties keep it honest:
 *
 *  - The model only ever NOMINATES. Which nominations are acted on is decided
 *    by `pickWinner` — the same confidence/recency/owner-confirmed precedence
 *    consolidation uses — so a low-confidence extraction cannot expire a fact
 *    the owner confirmed by hand, whatever the model claims.
 *  - It fails open. A budget stop, a provider outage, or an unparseable reply
 *    leaves the save exactly as it was: appended, with consolidation still due
 *    to catch it that night. Losing a correction's *timeliness* is the bug
 *    this closes; losing the correction itself would be a worse one.
 *
 * Deliberately narrow. Only `knowledge` is checked — an `experience` episode
 * records that something happened, and a later episode does not falsify it —
 * and the candidate query excludes quarantined facts, so an untrusted write
 * awaiting the owner's review can neither retire nor be retired here.
 */

const ContradictionSchema = z.object({
  replaces: z
    .array(z.string())
    .max(16)
    .default([])
    .describe('ids of the listed facts that the new fact directly contradicts and replaces'),
});
type Contradiction = z.infer<typeof ContradictionSchema>;

export interface SupersedeResult {
  /** Ids of facts retired by this write. */
  superseded: string[];
  /** Why nothing happened, when nothing did — for the caller's telemetry. */
  skipped?: 'ineligible' | 'no-candidates' | 'model-unavailable';
}

const NOTHING: SupersedeResult = { superseded: [] };

/**
 * Which nominations this write may actually retire. Pure, so the precedence
 * rule is testable without a database or a model — and so the guard that
 * protects a hand-confirmed fact is one readable function rather than a
 * condition buried in a query.
 *
 * `pickWinner` already encodes the whole rule (owner-confirmed beats
 * everything, then confidence, then newest). Running it pairwise against the
 * incoming fact means write-time and nightly supersession cannot drift apart:
 * if consolidation would not have retired this fact tonight, neither does this.
 */
export function supersedableIds(
  newFact: SupersedeFact,
  candidates: readonly SupersedeFact[],
  nominated: readonly string[],
): string[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const retired: string[] = [];
  for (const id of new Set(nominated)) {
    // A model may name an id that was never offered, or name the new fact
    // itself. Neither is a contradiction anyone can act on.
    const candidate = byId.get(id);
    if (!candidate || candidate.id === newFact.id) continue;
    if (pickWinner([candidate, newFact]).id !== newFact.id) continue;
    retired.push(id);
  }
  return retired;
}

/**
 * Retire the live facts a newly saved fact contradicts.
 *
 * Call this after the insert has committed, for a `knowledge` write from an
 * owner- or assistant-trust task. Never throws: every failure path returns a
 * result, because the caller's save has already succeeded and must stand
 * whatever happens here.
 */
export async function supersedeContradictedFacts(
  deps: {
    memory: MemorySupersedeRepository;
    router: ModelRouter;
    /**
     * Recompile the owner card. The card is a snapshot of the live facts that
     * is injected into prompts wholesale, so without this the text just
     * retired keeps answering until the next nightly run — the exact staleness
     * this check exists to end. Injected rather than imported so core stays
     * clear of a database handle; absent simply means no card to refresh.
     */
    onRetired?: () => Promise<unknown>;
  },
  input: { agentId: string; newFactId: string; taskId?: string },
): Promise<SupersedeResult> {
  const { memory, router } = deps;
  return withSpan('memory.supersede', {}, async () => {
    const newFact = await memory.writtenFact({ agentId: input.agentId, id: input.newFactId });
    // A row stored without an embedding cannot be compared against anything,
    // and a row that vanished between the insert and here is not ours to
    // reason about.
    if (!newFact?.embedding) return { ...NOTHING, skipped: 'ineligible' };

    const candidates = await memory.candidates({
      agentId: input.agentId,
      newFactId: input.newFactId,
      embedding: newFact.embedding,
      subjectContactId: newFact.subjectContactId,
    });
    if (candidates.length === 0) return { ...NOTHING, skipped: 'no-candidates' };

    const listing = candidates
      .map((candidate) => `id=${candidate.id} | ${candidate.content}`)
      .join('\n');

    const outcome = await router
      .object<Contradiction>('classify', {
        ...(input.taskId ? { taskId: input.taskId } : {}),
        schema: ContradictionSchema,
        system: [
          'A personal assistant just recorded a new fact about someone. Decide which of the',
          'existing facts it REPLACES — the ones that cannot still be true now that the new',
          'fact is. Refer to facts ONLY by their id.',
          'Replace only on a direct conflict about the SAME attribute: a new home city replaces',
          'the old home city, a new job title replaces the old job title, a new phone number',
          'replaces the old phone number.',
          'Facts that can both be true are NOT replacements. Different attributes of one person',
          '(where they live AND where they work), extra detail about the same attribute, and a',
          'second instance of something a person can have several of (a sibling, a hobby, a',
          'language) all stay.',
          'An explicitly historical statement ("used to live in Oslo") replaces nothing — it is',
          'already about the past.',
          'When in doubt, leave the existing fact alone: keeping a stale fact is recoverable,',
          'and the nightly review will catch it. Return an empty array when nothing is',
          'replaced. That is the common answer.',
        ].join('\n'),
        prompt: `New fact:\n${newFact.content}\n\nExisting facts:\n${listing}`,
      })
      .catch((err: unknown) => {
        // A reply this small failing to parse means the check is unavailable
        // right now, not that the save is bad. Anything else is a real fault
        // and belongs to the caller.
        if (!isUnparseableObjectError(err)) throw err;
        console.error('memory supersede: unparseable contradiction verdict', err);
        return null;
      });
    if (outcome === null || !outcome.ok) {
      // Includes a budget stop. Unlike consolidation — a batch job that should
      // park and resume — this rides on an owner-facing save that has already
      // committed, so it declines quietly and leaves the work to the sweep.
      return { ...NOTHING, skipped: 'model-unavailable' };
    }

    const nominated = supersedableIds(newFact, candidates, outcome.object.replaces);
    if (nominated.length === 0) return NOTHING;

    const superseded = await memory.retire({
      agentId: input.agentId,
      replacementId: input.newFactId,
      ids: nominated,
    });
    if (superseded.length > 0) {
      // Best-effort: the facts are already retired, and a card that is one
      // sweep out of date is strictly better than losing that.
      await deps.onRetired?.().catch((err: unknown) => {
        console.error('memory supersede: owner card refresh failed', err);
      });
    }
    return { superseded };
  });
}
