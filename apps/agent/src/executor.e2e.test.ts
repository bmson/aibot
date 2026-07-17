import type { InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import { enqueueTask, executeTask, getAgent, resolveApproval } from '@assistant/core';
import {
  approvals,
  conversations,
  createDb,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];
const executions: Record<string, number> = {};

/**
 * Scripted model: proposes exec.counter, then exec.outbound, then finishes.
 * Decisions derive from the transcript, so resume-from-checkpoint follows the
 * same script without any state inside the fake.
 */
function makeFakeRouter(opts: { throwOnStep?: number } = {}) {
  let stepCalls = 0;
  const fake = {
    async object() {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        object: { action: 'workflow', reasoning: '', steps: ['count', 'send'], missingInfo: [] },
      };
    },
    async step(_role: string, callOpts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      stepCalls += 1;
      if (opts.throwOnStep === stepCalls) throw new Error('simulated crash');

      const transcript = JSON.stringify(callOpts.messages ?? []);
      const hasCounterResult =
        transcript.includes('"toolName":"exec.counter"') && transcript.includes('tool-result');
      const hasOutboundResult =
        transcript.includes('"toolName":"exec.outbound"') &&
        transcript.split('"toolName":"exec.outbound"').length > 2;

      if (!hasCounterResult) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [{ toolCallId: 'call_counter', toolName: 'exec.counter', input: {} }],
        };
      }
      if (!hasOutboundResult) {
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'call_outbound',
              toolName: 'exec.outbound',
              input: { message: 'hello world' },
            },
          ],
        };
      }
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: 'All done: counted and sent.',
        toolCalls: [],
      };
    },
  };
  return fake as unknown as ModelRouter;
}

function makeRegistry(taskKey: string) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'exec.counter',
    description: 'increments a counter (side effect under test)',
    inputSchema: z.object({}),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    idempotencyKey: () => `exec-counter-${taskKey}`,
    execute: async () => {
      executions[taskKey] = (executions[taskKey] ?? 0) + 1;
      return { count: executions[taskKey] };
    },
  });
  registry.register(
    {
      name: 'exec.outbound',
      description: 'sends a message to a human (approval-gated)',
      inputSchema: z.object({ message: z.string() }),
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => `send "${(args as { message: string }).message}"`,
      execute: async (args) => ({ sent: true, message: (args as { message: string }).message }),
    },
    { outwardFacing: true },
  );
  return registry;
}

function event(): InboundEvent {
  return { source: 'internal', agentId, trust: 'owner', payload: {} };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
    await db
      .delete(approvals)
      .where(
        sql`${approvals.toolCallId} IN (select id from ${toolCalls} where ${toolCalls.toolName} LIKE 'exec.%')`,
      );
    await db.delete(toolCalls).where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
  } catch {
    console.warn('executor.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
    await db
      .delete(approvals)
      .where(
        sql`${approvals.toolCallId} IN (select id from ${toolCalls} where ${toolCalls.toolName} LIKE 'exec.%')`,
      );
    await db.delete(toolCalls).where(sql`${toolCalls.toolName} LIKE 'exec.%'`);
    if (createdConversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
    }
    if (createdTaskIds.length) await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    if (createdConversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('executor end-to-end (integration, scripted model)', () => {
  it('runs tools, parks on approval, resumes after approval, completes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t1-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    const router = makeFakeRouter();

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    // Run 1: counter executes, outbound parks
    const run1 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run1.outcome).toBe('parked');
    expect(executions[key]).toBe(1);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_approval');
    expect(row?.plan).toMatchObject({ action: 'workflow' });

    // A queue redelivery while parked must be a no-op
    const redelivery = await executeTask({ db, router, dispatcher }, task.id);
    expect(redelivery.outcome).toBe('not_claimable');

    // The approval exists with the exact payload
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    expect(approval?.status).toBe('pending');
    expect(approval?.payload).toEqual({ message: 'hello world' });

    // Owner approves (with an edit) → task wakes
    const resolved = await resolveApproval(db, {
      approvalId: approval?.id,
      decision: 'approved',
      via: 'web',
      editedPayload: { message: 'hello edited world' },
    });
    expect(resolved.ok).toBe(true);

    // Run 2: resumes from checkpoint, executes the approved (edited) call, finishes
    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('done');
    expect(executions[key]).toBe(1); // counter did NOT run again — checkpoint held

    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');

    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const outbound = calls.find((c) => c.toolName === 'exec.outbound');
    expect(outbound?.status).toBe('succeeded');
    expect(outbound?.result).toMatchObject({ message: 'hello edited world' }); // edit applied
  });

  it('denied approvals resume with a denial result and still complete', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t2-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    const router = makeFakeRouter();

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    await executeTask({ db, router, dispatcher }, task.id);
    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    await resolveApproval(db, { approvalId: approval?.id, decision: 'denied', via: 'web' });

    const run2 = await executeTask({ db, router, dispatcher }, task.id);
    expect(run2.outcome).toBe('done'); // fake sees the denial tool-result and finishes

    const calls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
    const outbound = calls.find((c) => c.toolName === 'exec.outbound');
    expect(outbound?.status).toBe('denied');
  });

  it('an approval park in a conversation posts a notice message (the thread never goes silent)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t4-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));
    const router = makeFakeRouter();

    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'exec-notice-test' })
      .returning();
    const convId = (conversation as NonNullable<typeof conversation>).id;
    createdConversationIds.push(convId);
    await db.insert(messages).values({
      conversationId: convId,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text: 'please count then send hello world' }],
      text: 'please count then send hello world',
      embedding: new Array(1536).fill(0.01),
    });

    const { task } = await enqueueTask(db, {
      event: { ...event(), conversationId: convId },
      type: 'chat_turn',
    });
    createdTaskIds.push(task.id);

    const run = await executeTask({ db, router, dispatcher }, task.id);
    expect(run.outcome).toBe('parked');

    const [approval] = await db.select().from(approvals).where(eq(approvals.taskId, task.id));
    const thread = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    const last = thread.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.text).toContain('approval');
    expect(last?.text).toContain(approval?.shortCode ?? '@@missing@@');
  });

  it('a crash mid-run retries and resumes from the checkpoint without double side effects', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `t3-${Date.now()}`;
    const dispatcher = new ToolDispatcher(db, makeRegistry(key));

    const { task } = await enqueueTask(db, { event: event(), type: 'adhoc' });
    createdTaskIds.push(task.id);

    // step 2 throws — AFTER the counter executed and was checkpointed
    const crashy = makeFakeRouter({ throwOnStep: 2 });
    const run1 = await executeTask({ db, router: crashy, dispatcher }, task.id);
    expect(run1.outcome).toBe('failed');
    expect(executions[key]).toBe(1);

    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('pending'); // queued for retry, not dead

    // Retry with a healthy model: resumes from checkpoint — counter NOT re-run
    const healthy = makeFakeRouter();
    const run2 = await executeTask({ db, router: healthy, dispatcher }, task.id);
    expect(run2.outcome).toBe('parked'); // proceeds to the outbound approval
    expect(executions[key]).toBe(1);

    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_approval');
  });
});
