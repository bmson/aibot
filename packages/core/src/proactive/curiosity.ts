import type { Db } from '@assistant/db';
import type { ExecutionPersistence } from '@assistant/persistence';
import { getAgent, postOwnerNotice } from '../chat.js';
import { findGraphGaps, markGapAsked, nextUnaskedGap } from '../memory/graph-gaps.js';
import { withSpan } from '../otel.js';
import { type ProactiveNotifier, pingOwner } from './notify.js';

/**
 * One question a day, at most, about something the assistant does not know.
 *
 * The knowledge graph is written entirely by extraction — it records what the
 * owner happened to mention and never goes looking. This is the other half:
 * the assistant noticing a structural hole (`memory/graph-gaps.ts` computes
 * them from rows, never from a model's imagination) and simply asking.
 *
 * The answer needs no machinery. It arrives as an ordinary reply in the
 * owner's thread, where `memory.extract` and then `memory.graph_sync` already
 * pick it up. That is why a question is a notice and not a suggestion: a
 * suggestion's "yes" enqueues a task, and there is no task here — the reply
 * *is* the outcome.
 *
 * Bounded hard, because a curious assistant becomes a tiresome one fast: one
 * question per run, one run a day, and a gap that has been asked once is never
 * asked again even if the owner ignored it.
 */

export interface CuriosityResult {
  gapsFound: number;
  asked: string | null;
  pinged: boolean;
}

export async function runCuriosity(
  deps: {
    db: Db;
    notifyOwner?: ProactiveNotifier;
    heartbeat?: () => Promise<void>;
    /** The portable graph reads, asked-gap ledger and notice writer; PostgreSQL without them. */
    persistence?: Pick<ExecutionPersistence, 'graphCuriosity' | 'suggestions' | 'ownerNotices'>;
  },
  opts: { agentId?: string; taskId?: string; now?: Date } = {},
): Promise<CuriosityResult> {
  const { db } = deps;
  const now = opts.now ?? new Date();
  const graph = deps.persistence?.graphCuriosity;
  const ledger = deps.persistence?.suggestions;
  const notices = deps.persistence?.ownerNotices;
  const portable = graph && ledger && notices ? { graph, ledger, notices } : null;
  if (graph && !portable)
    throw new Error('Portable curiosity needs the suggestion ledger and owner notices');

  return withSpan('proactive.curiosity', {}, async () => {
    const agentId = portable && opts.agentId ? opts.agentId : (await getAgent(db)).id;
    const result: CuriosityResult = { gapsFound: 0, asked: null, pinged: false };

    const gaps = await findGraphGaps(portable?.graph ?? db, agentId, now);
    result.gapsFound = gaps.length;
    await deps.heartbeat?.();

    const gap = await nextUnaskedGap(portable?.graph ?? db, agentId, gaps);
    // Nothing worth asking is the normal case, and it produces silence — the
    // same self-silence rule the briefing and the pulse follow.
    if (!gap) return result;

    // Claim before asking: two instances must not both put the same question.
    if (!(await markGapAsked(portable?.ledger ?? db, agentId, gap, now))) return result;

    const { conversationId } = await postOwnerNotice(portable?.notices ?? db, {
      agentId,
      text: gap.question,
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    });
    result.asked = gap.kind;
    result.pinged = await pingOwner(deps.notifyOwner, {
      conversationId,
      text: gap.question.slice(0, 200),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    });
    return result;
  });
}

/** The job registry's summary line. */
export function curiositySummary(result: CuriosityResult): string {
  if (!result.asked) return `curiosity: nothing to ask (${result.gapsFound} gap(s) known)`;
  return `curiosity: asked about a ${result.asked} gap${result.pinged ? ' + pinged' : ''}, ${result.gapsFound} known`;
}
