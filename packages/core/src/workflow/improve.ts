import { createHash } from 'node:crypto';
import {
  agents,
  type Db,
  type ImprovementProposalRow,
  improvementProposals,
  isTombstoned,
  memories,
  modelCalls,
  modelRoles,
  models,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { notifyOwnerInNotifications } from './anomaly.js';

/**
 * Self-improvement loop (Phase 12). A nightly eval mines the recent failure,
 * retry, dead-letter, and cost-outlier signals from `tool_calls`/`tasks`/
 * `model_calls`, records the pattern as an `experience` memory, and drafts
 * concrete change proposals. Proposals are NEVER auto-applied — the owner
 * approves (which enacts an applyable model-role/policy change) or dismisses.
 */

const WINDOW_DAYS = 7;
const MIN_FAILURES = 2;
const COST_OUTLIER_USD = 0.1;
const VALID_ROLES = new Set([
  'plan',
  'classify',
  'extract',
  'draft',
  'reason',
  'rewrite',
  'embed',
  'batch',
]);

/** Collapse a tool error to a stable signature so repeats group together. */
function errorSignature(error: string | null): string {
  return (error ?? 'unknown')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>')
    .replace(/\d+/g, '#')
    .slice(0, 80)
    .trim();
}

const ProposalDraftSchema = z.object({
  kind: z.enum(['model_role', 'policy', 'prompt', 'note']),
  title: z.string().min(3).max(200),
  rationale: z.string().max(1000).default(''),
  role: z.string().max(20).default('').describe('For model_role: which role to change.'),
  primaryModel: z.string().max(120).default(''),
  fallbackModel: z.string().max(120).default(''),
  toolName: z.string().max(120).default('').describe('For policy: the tool.'),
  suggestion: z.string().max(1000).default('').describe('For prompt/note: the advice.'),
});
const ProposalsOutputSchema = z.object({
  proposals: z.array(ProposalDraftSchema).max(3),
});

const IMPROVE_SYSTEM = [
  "You review the assistant's recent failures, retries, and cost outliers and propose AT MOST 3 concrete, conservative improvements.",
  'Kinds: "model_role" (swap a role\'s model — only if a role clearly and repeatedly underperforms; give role + primaryModel), "policy" (a targeted approval rule — rare), "prompt" (advise a wording change — advisory), "note" (a general observation — advisory).',
  'Prefer "note"/"prompt" unless a config change is clearly warranted by the evidence. Each proposal needs a short title and a rationale citing the pattern. If nothing is actionable, return an empty proposals array.',
].join('\n');

export interface SelfImproveResult {
  patterns: number;
  proposalsDrafted: number;
  experienceSaved: boolean;
}

/** Nightly self-improvement scan for the (single) agent. */
export async function runSelfImprove(
  deps: { db: Db; router: ModelRouter; heartbeat?: () => Promise<void> },
  opts: { taskId?: string; now?: Date } = {},
): Promise<SelfImproveResult> {
  const { db, router } = deps;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);

  return withSpan('self.improve', {}, async () => {
    await deps.heartbeat?.();
    const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!agent) return { patterns: 0, proposalsDrafted: 0, experienceSaved: false };
    const agentId = agent.id;

    // 1. Failure patterns by tool + error signature.
    const failedCalls = await db
      .select({ toolName: toolCalls.toolName, error: toolCalls.error })
      .from(toolCalls)
      .where(and(eq(toolCalls.status, 'failed'), gte(toolCalls.createdAt, since)));
    const failureCounts = new Map<string, { toolName: string; sig: string; count: number }>();
    for (const c of failedCalls) {
      const sig = errorSignature(c.error);
      const key = `${c.toolName}|${sig}`;
      const entry = failureCounts.get(key) ?? { toolName: c.toolName, sig, count: 0 };
      entry.count += 1;
      failureCounts.set(key, entry);
    }
    const topFailures = [...failureCounts.values()]
      .filter((f) => f.count >= MIN_FAILURES)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // 2. Dead-lettered / needs-attention tasks.
    const [stuck] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, ['needs_attention', 'failed']),
          gte(tasks.updatedAt, since),
          gte(tasks.attempt, 2),
        ),
      );
    const stuckCount = Number(stuck?.n ?? 0);

    // 3. Cost outliers.
    const outliers = await db
      .select({ taskId: modelCalls.taskId, role: modelCalls.role, cost: modelCalls.costUsd })
      .from(modelCalls)
      .where(
        and(gte(modelCalls.createdAt, since), gte(modelCalls.costUsd, String(COST_OUTLIER_USD))),
      )
      .orderBy(desc(modelCalls.costUsd))
      .limit(5);

    if (topFailures.length === 0 && stuckCount === 0 && outliers.length === 0) {
      return { patterns: 0, proposalsDrafted: 0, experienceSaved: false };
    }

    const summary = [
      'Recent reliability review (last 7 days):',
      ...topFailures.map((f) => `- ${f.toolName} failed ${f.count}× — "${f.sig}"`),
      stuckCount > 0 ? `- ${stuckCount} task(s) needed attention after retries` : '',
      ...outliers.map((o) => `- expensive ${o.role} call: $${Number(o.cost).toFixed(3)}`),
    ]
      .filter(Boolean)
      .join('\n');

    // Save the pattern as an experience memory (expires; competence, not fact).
    let experienceSaved = false;
    const content = `Self-improvement review: ${summary.slice(0, 500)}`.slice(0, 600);
    const contentHash = createHash('sha256').update(content).digest('hex');
    if (!(await isTombstoned(db, contentHash))) {
      const [embedding] = await router.embed([content], { taskId: opts.taskId });
      await deps.heartbeat?.();
      const [saved] = await db
        .insert(memories)
        .values({
          agentId,
          category: 'experience',
          kind: 'episode',
          content,
          contentHash,
          embedding,
          importance: 2,
          confidence: '0.80',
          originTrust: 'assistant',
          source: 'self-improve',
          sourceTaskId: opts.taskId,
          expiresAt: new Date(now.getTime() + 90 * 24 * 3600 * 1000),
        })
        .onConflictDoNothing({ target: memories.contentHash })
        .returning({ id: memories.id });
      experienceSaved = Boolean(saved);
    }

    // Draft concrete proposals.
    const outcome = await router
      .object<z.infer<typeof ProposalsOutputSchema>>('batch', {
        taskId: opts.taskId,
        schema: ProposalsOutputSchema,
        system: IMPROVE_SYSTEM,
        prompt: summary,
      })
      .catch((err) => {
        if (!isUnparseableObjectError(err)) throw err;
        console.error('self-improve: could not structure proposals', err);
        return null;
      });
    await deps.heartbeat?.();
    if (outcome === null) {
      return { patterns: topFailures.length, proposalsDrafted: 0, experienceSaved };
    }
    if (!outcome.ok) {
      throw new BudgetReservationError(
        outcome.decision.reason,
        outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
      );
    }

    const evidenceIds = [...new Set(topFailures.map((f) => `${f.toolName}:${f.sig}`))].slice(0, 20);
    let proposalsDrafted = 0;
    for (const draft of outcome.object.proposals) {
      const change: Record<string, unknown> =
        draft.kind === 'model_role'
          ? {
              role: draft.role,
              primaryModel: draft.primaryModel,
              fallbackModel: draft.fallbackModel,
            }
          : draft.kind === 'policy'
            ? { toolName: draft.toolName, suggestion: draft.suggestion }
            : { suggestion: draft.suggestion };
      const [inserted] = await db
        .insert(improvementProposals)
        .values({
          agentId,
          kind: draft.kind,
          title: draft.title.trim().slice(0, 200),
          rationale: draft.rationale,
          change,
          evidenceIds,
        })
        .onConflictDoNothing({
          target: [
            improvementProposals.agentId,
            improvementProposals.kind,
            improvementProposals.title,
          ],
        })
        .returning({ id: improvementProposals.id });
      if (inserted) proposalsDrafted += 1;
    }

    if (proposalsDrafted > 0) {
      await notifyOwnerInNotifications(
        db,
        agentId,
        `🔧 I drafted ${proposalsDrafted} improvement proposal${proposalsDrafted === 1 ? '' : 's'} from this week's reliability review. Review them on the [Improvements page](/improvements) — nothing changes until you approve.`,
        opts.taskId,
      ).catch((err) => console.error('self-improve: owner notify failed', err));
    }

    return { patterns: topFailures.length, proposalsDrafted, experienceSaved };
  });
}

// ── Dashboard operations ─────────────────────────────────────────────────────

export async function listOpenProposals(
  db: Db,
  agentId: string,
): Promise<ImprovementProposalRow[]> {
  return db
    .select()
    .from(improvementProposals)
    .where(and(eq(improvementProposals.agentId, agentId), eq(improvementProposals.status, 'open')))
    .orderBy(desc(improvementProposals.createdAt))
    .limit(100);
}

export async function dismissProposal(db: Db, id: string): Promise<void> {
  await db
    .update(improvementProposals)
    .set({ status: 'dismissed', updatedAt: sql`now()` })
    .where(eq(improvementProposals.id, id));
}

/**
 * Enact an approved proposal. model_role/policy changes are applied to the live
 * config after validation; prompt/note proposals (and any malformed change) are
 * advisory and merely acknowledged. Never touched without the owner approving.
 */
export async function applyProposal(
  db: Db,
  id: string,
): Promise<{ enacted: boolean; detail: string }> {
  const [proposal] = await db
    .select()
    .from(improvementProposals)
    .where(eq(improvementProposals.id, id));
  if (proposal?.status !== 'open') return { enacted: false, detail: 'not applicable' };

  let enacted = false;
  let detail = 'acknowledged (advisory)';
  const change = (proposal.change ?? {}) as Record<string, unknown>;

  if (proposal.kind === 'model_role') {
    // A live routing swap must point at the pattern it claims to fix. A
    // proposal with no evidence rows is an opinion, and opinions do not get to
    // change which model answers the owner.
    if (proposal.evidenceIds.length === 0) {
      return { enacted: false, detail: 'model_role change refused: proposal cites no evidence' };
    }
    const role = typeof change.role === 'string' ? change.role : '';
    const primaryModel = typeof change.primaryModel === 'string' ? change.primaryModel : '';
    const fallbackModel = typeof change.fallbackModel === 'string' ? change.fallbackModel : '';
    const wanted = [primaryModel, fallbackModel].filter(Boolean);
    const known = wanted.length
      ? new Set(
          (
            await db
              .select({ id: models.id })
              .from(models)
              .where(and(inArray(models.id, wanted), eq(models.enabled, true)))
          ).map((m) => m.id),
        )
      : new Set<string>();
    if (VALID_ROLES.has(role) && (primaryModel || fallbackModel)) {
      const set: Record<string, unknown> = { updatedAt: sql`now()` };
      if (primaryModel && known.has(primaryModel)) set.primaryModel = primaryModel;
      if (fallbackModel && known.has(fallbackModel)) set.fallbackModel = fallbackModel;
      if (set.primaryModel || set.fallbackModel) {
        await db.update(modelRoles).set(set).where(eq(modelRoles.role, role));
        enacted = true;
        detail = `swapped ${role} model`;
      } else {
        detail = 'proposed model is unknown — recorded only';
      }
    }
  } else if (proposal.kind === 'policy') {
    // Policy proposals from the model lack a validated template/match, so they
    // are advisory here — the owner creates the exact rule from the approval flow.
    detail = 'policy suggestion — create the exact rule from an approval card';
  }

  await db
    .update(improvementProposals)
    .set({ status: 'applied', updatedAt: sql`now()` })
    .where(eq(improvementProposals.id, id));
  return { enacted, detail };
}
