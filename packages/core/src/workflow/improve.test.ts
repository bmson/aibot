import {
  createDb,
  type Db,
  improvementProposals,
  memories,
  modelRoles,
  models,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray, like, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { applyProposal, dismissProposal, listOpenProposals, runSelfImprove } from './improve.js';
import { enqueueTask } from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const fakeRouter = {
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.03));
  },
  async object() {
    return {
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      object: {
        proposals: [
          {
            kind: 'note',
            title: 'xtest-improve-note',
            rationale: 'xtest-fail-tool keeps failing; investigate the selector',
            role: '',
            primaryModel: '',
            fallbackModel: '',
            toolName: '',
            suggestion: 'add a retry',
          },
        ],
      },
    };
  },
} as unknown as ModelRouter;

describe('self-improvement loop', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let taskId: string;
  const createdProposalIds: string[] = [];

  async function cleanup() {
    await db.delete(improvementProposals).where(like(improvementProposals.title, 'xtest%'));
    if (createdProposalIds.length) {
      await db
        .delete(improvementProposals)
        .where(inArray(improvementProposals.id, createdProposalIds));
    }
    await db.delete(memories).where(like(memories.content, '%xtest-fail-tool%'));
    if (taskId) {
      await db.delete(toolCalls).where(eq(toolCalls.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup(); // clear stale xtest rows before creating this run's task
      const { task } = await enqueueTask(db, {
        event: { source: 'internal', agentId, trust: 'assistant', payload: { note: 'xtest' } },
        type: 'adhoc',
      });
      taskId = task.id;
    } catch {
      console.warn('improve.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('mines a failure pattern into an experience memory and drafts a proposal', async (ctx) => {
    if (!dbUp) return ctx.skip();
    for (let i = 0; i < 3; i++) {
      await db.insert(toolCalls).values({
        taskId,
        step: i,
        toolName: 'xtest-fail-tool',
        args: {},
        risk: 'autonomous',
        status: 'failed',
        error: 'timed out reaching the vendor form',
      });
    }

    const r = await runSelfImprove({ db, router: fakeRouter });
    expect(r.patterns).toBeGreaterThanOrEqual(1);
    expect(r.proposalsDrafted).toBeGreaterThanOrEqual(1);
    expect(r.experienceSaved).toBe(true);

    const [exp] = await db
      .select()
      .from(memories)
      .where(and(eq(memories.source, 'self-improve'), like(memories.content, '%xtest-fail-tool%')));
    expect(exp?.category).toBe('experience');
    expect(exp?.expiresAt).not.toBeNull();

    const proposals = (await listOpenProposals(db, agentId)).filter((p) =>
      p.title.startsWith('xtest'),
    );
    expect(proposals.some((p) => p.title === 'xtest-improve-note')).toBe(true);
  });

  it('applies a model-role swap to a valid enabled model and restores', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [draftRole] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
    if (!draftRole) return ctx.skip();
    const original = draftRole.primaryModel;
    const [otherModel] = await db
      .select({ id: models.id })
      .from(models)
      .where(and(eq(models.enabled, true), ne(models.id, original)))
      .limit(1);
    if (!otherModel) return ctx.skip();

    const [proposal] = await db
      .insert(improvementProposals)
      .values({
        agentId,
        kind: 'model_role',
        title: 'xtest-swap-draft',
        rationale: 'draft underperforms',
        change: { role: 'draft', primaryModel: otherModel.id, fallbackModel: '' },
        // A live routing swap is refused without cited evidence rows.
        evidenceIds: ['draft:xtest-signature'],
      })
      .returning();
    createdProposalIds.push(proposal?.id ?? '');

    try {
      const result = await applyProposal(db, proposal?.id ?? '');
      expect(result.enacted).toBe(true);
      const [after] = await db.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
      expect(after?.primaryModel).toBe(otherModel.id);
      const [row] = await db
        .select({ status: improvementProposals.status })
        .from(improvementProposals)
        .where(eq(improvementProposals.id, proposal?.id ?? ''));
      expect(row?.status).toBe('applied');
    } finally {
      // Never leave the shared DB's routing changed.
      await db
        .update(modelRoles)
        .set({ primaryModel: original })
        .where(eq(modelRoles.role, 'draft'));
    }
  });

  it('treats an unknown-model swap as advisory (enacts nothing) and dismisses', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [bad] = await db
      .insert(improvementProposals)
      .values({
        agentId,
        kind: 'model_role',
        title: 'xtest-bad-swap',
        change: { role: 'draft', primaryModel: 'no/such-model', fallbackModel: '' },
      })
      .returning();
    createdProposalIds.push(bad?.id ?? '');
    const result = await applyProposal(db, bad?.id ?? '');
    expect(result.enacted).toBe(false);

    const [note] = await db
      .insert(improvementProposals)
      .values({ agentId, kind: 'note', title: 'xtest-dismiss-me', change: {} })
      .returning();
    createdProposalIds.push(note?.id ?? '');
    await dismissProposal(db, note?.id ?? '');
    const open = (await listOpenProposals(db, agentId)).filter(
      (p) => p.title === 'xtest-dismiss-me',
    );
    expect(open).toHaveLength(0);
  });
});
