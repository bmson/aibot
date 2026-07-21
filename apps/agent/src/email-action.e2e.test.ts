import type { InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import { enqueueTask, executeTask, getAgent } from '@assistant/core';
import { conversations, createDb, type Db, messages, tasks, toolCalls } from '@assistant/db';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];

// The planner routes an actionable email to 'workflow'; roleForTask then picks
// 'reason' and the step loop forces a tool call on step 0.
const workflowPlan = {
  action: 'workflow',
  reasoning: 'the owner asked for a concrete action',
  steps: ['create the calendar event'],
  missingInfo: [],
};

function registry() {
  return new ToolRegistry().register({
    name: 'calendar.test_create',
    description: 'Create a test calendar event.',
    inputSchema: z.object({ title: z.string() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args) => ({ created: true, title: (args as { title: string }).title }),
  });
}

function emailEvent(conversationId: string): InboundEvent {
  return {
    source: 'email',
    externalEventId: `gmail:action-${Date.now()}`,
    agentId,
    conversationId,
    trust: 'owner',
    payload: {
      threadId: 'thread-x',
      messageId: 'msg-x',
      from: 'owner@example.com',
      subject: 'add lunch friday',
      // Owner-authored (not a forward) — untainted so it can act autonomously.
      quotesExternalContent: false,
    },
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-action.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdConversationIds.length) {
    // messages reference tasks (task_id FK), so clear them before the tasks.
    await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
  }
  if (dbUp && createdTaskIds.length) {
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdConversationIds.length) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('email action routing (integration, scripted model)', () => {
  it('runs an actionable email on the reason model with a forced step-0 tool call', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner', title: 'add lunch friday' })
      .returning({ id: conversations.id });
    const conversationId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(conversationId);

    const { task } = await enqueueTask(db, {
      type: 'email_triage',
      event: emailEvent(conversationId),
      maxSteps: 8,
    });
    createdTaskIds.push(task.id);

    const rolesSeen: string[] = [];
    const step0ToolChoice: Array<string | undefined> = [];
    let step = 0;
    const router = {
      async object() {
        return { ok: true, modelId: 'fake/model', degraded: false, object: workflowPlan };
      },
      async step(
        role: string,
        opts: { toolChoice?: { type?: string; toolName?: string } | string },
      ): Promise<StepCallOutcome> {
        rolesSeen.push(role);
        const current = step;
        step += 1;
        if (current === 0) {
          step0ToolChoice.push(typeof opts.toolChoice === 'string' ? opts.toolChoice : undefined);
          return {
            ok: true,
            modelId: 'fake/model',
            degraded: false,
            text: '',
            toolCalls: [
              { toolCallId: 'cal-1', toolName: 'calendar.test_create', input: { title: 'Lunch' } },
            ],
          };
        }
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: 'Added lunch to your calendar for Friday.',
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    } as unknown as ModelRouter;

    const outcome = await executeTask(
      { db, router, dispatcher: new ToolDispatcher(db, registry()) },
      task.id,
    );

    expect(outcome.outcome).toBe('done');
    // E1: email action drives the reasoning model, not draft.
    expect(rolesSeen.every((r) => r === 'reason')).toBe(true);
    // D2: the first step was forced to produce a tool call.
    expect(step0ToolChoice[0]).toBe('required');
    // The tool actually ran (no prose-with-zero-tools).
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    expect(
      calls.some((c) => c.toolName === 'calendar.test_create' && c.status === 'succeeded'),
    ).toBe(true);
  });
});
