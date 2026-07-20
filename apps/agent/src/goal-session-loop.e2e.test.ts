import type { InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import { enqueueTask, executeTask, getAgent } from '@assistant/core';
import {
  conversations,
  costEvents,
  costReservations,
  createDb,
  type Db,
  goals,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];
const createdGoalIds: string[] = [];

/**
 * A model that answers in prose and never calls a tool — the exact behavior
 * that let the Job Exploration goal report "done" for two days while doing
 * nothing at all.
 */
function proseOnlyRouter(plan: Record<string, unknown>): ModelRouter {
  return {
    async object() {
      return { ok: true, modelId: 'fake/model', degraded: false, object: plan };
    },
    async step(): Promise<StepCallOutcome> {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: "I'll start searching job boards and report back with the first batch shortly.",
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  } as unknown as ModelRouter;
}

const workflowPlan = {
  action: 'workflow',
  reasoning: 'criteria are settled',
  steps: ['search boards', 'apply'],
  missingInfo: [],
};

const clarifyPlan = {
  action: 'clarify',
  reasoning: 'needs detail',
  steps: [],
  missingInfo: ['Remote only or specific locations?'],
};

async function seedGoal(title: string): Promise<{ goalId: string; conversationId: string }> {
  const [goal] = await db
    .insert(goals)
    .values({ agentId, title, description: 'find a job', progress: 'First task queued.' })
    .returning({ id: goals.id });
  const goalId = (goal as NonNullable<typeof goal>).id;
  createdGoalIds.push(goalId);

  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: `Work: ${title}`,
      metadata: { goalId },
    })
    .returning({ id: conversations.id });
  const conversationId = (conversation as NonNullable<typeof conversation>).id;
  createdConversationIds.push(conversationId);
  return { goalId, conversationId };
}

function event(conversationId: string): InboundEvent {
  return { source: 'schedule', agentId, trust: 'assistant', conversationId, payload: {} };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('goal-session-loop.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (!dbUp) return;
  if (createdTaskIds.length) {
    // Every one of these references tasks; drop them in dependency order.
    await db.delete(costReservations).where(inArray(costReservations.taskId, createdTaskIds));
    await db.delete(costEvents).where(inArray(costEvents.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(messages).where(inArray(messages.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (createdConversationIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdGoalIds.length) await db.delete(goals).where(inArray(goals.id, createdGoalIds));
});

describe('unattended goal sessions never report silent success', () => {
  it('parks a goal session that finished without any verified tool result', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { goalId, conversationId } = await seedGoal('Job Exploration workflow');
    const { task } = await enqueueTask(db, {
      event: event(conversationId),
      type: 'scheduled',
      goalId,
    });
    createdTaskIds.push(task.id);

    const outcome = await executeTask(
      {
        db,
        router: proseOnlyRouter(workflowPlan),
        dispatcher: new ToolDispatcher(db, new ToolRegistry()),
      },
      task.id,
    );

    expect(outcome.outcome).toBe('needs_attention');
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('needs_attention');
  });

  it('parks a goal session that stopped to ask a question, and records it on the goal', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { goalId, conversationId } = await seedGoal('Job Exploration clarify');
    const { task } = await enqueueTask(db, {
      event: event(conversationId),
      type: 'scheduled',
      goalId,
    });
    createdTaskIds.push(task.id);

    const outcome = await executeTask(
      {
        db,
        router: proseOnlyRouter(clarifyPlan),
        dispatcher: new ToolDispatcher(db, new ToolRegistry()),
      },
      task.id,
    );

    expect(outcome.outcome).toBe('needs_attention');
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('needs_attention');

    // The next session is re-seeded from the goal row, so the open question
    // has to live there — otherwise tomorrow's run re-asks it.
    const [goal] = await db.select().from(goals).where(eq(goals.id, goalId));
    expect(goal?.nextAction).toContain('Waiting on the owner');
    expect(goal?.nextAction).toContain('Remote only or specific locations?');
  });

  it('leaves an owner chat turn completed — the owner is reading it live', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { goalId, conversationId } = await seedGoal('Job Exploration chat');
    const { task } = await enqueueTask(db, {
      event: { ...event(conversationId), source: 'chat', trust: 'owner' },
      type: 'chat_turn',
      goalId,
    });
    createdTaskIds.push(task.id);

    const outcome = await executeTask(
      {
        db,
        router: proseOnlyRouter(workflowPlan),
        dispatcher: new ToolDispatcher(db, new ToolRegistry()),
      },
      task.id,
    );

    expect(outcome.outcome).toBe('done');
  });
});
