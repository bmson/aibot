import type { InboundEvent, ModelRouter, StepCallOutcome } from '@assistant/core';
import { enqueueTask, executeTask, getAgent, resolveApproval } from '@assistant/core';
import {
  approvals,
  conversations,
  createDb,
  type Db,
  messages,
  type TaskRow,
  tasks,
  toolCalls,
} from '@assistant/db';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];

// Every gmail.send that ACTUALLY executed. Approve must append; deny must not.
const sent: Array<{ to: string[]; subject: string; body: string; threadId?: string }> = [];

/** A gmail.send test double: risk:'approval' + outward/egress, so it always parks. */
function registry() {
  return new ToolRegistry().register(
    {
      name: 'gmail.send',
      description: 'Send an email (test double). Always requires owner approval.',
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1),
        subject: z.string(),
        body: z.string(),
        threadId: z.string().optional(),
      }),
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => {
        const a = args as { to: string[]; subject: string };
        return `Send email to ${a.to.join(', ')} — "${a.subject}"`;
      },
      execute: async (args) => {
        const a = args as { to: string[]; subject: string; body: string; threadId?: string };
        sent.push(a);
        return { messageId: 'sent-1', to: a.to, threadId: a.threadId };
      },
    },
    { outwardFacing: true, networkEgress: true },
  );
}

function deps(router: ModelRouter) {
  return { db, router, dispatcher: new ToolDispatcher(db, registry()) };
}

const SENDER = 'contact@example.com';
const SUBJECT = 'question about the report';
const REPLY_SUBJECT = 'Re: question about the report';

function emailEvent(
  conversationId: string,
  threadId: string,
  trust: 'known' | 'unknown',
  suffix: string,
): InboundEvent {
  return {
    source: 'email',
    externalEventId: `gmail:${trust}-${suffix}-${Date.now()}`,
    agentId,
    conversationId,
    trust,
    payload: {
      threadId,
      messageId: `msg-${suffix}`,
      rfcMessageId: `<${suffix}@example.com>`,
      from: SENDER,
      subject: SUBJECT,
      quotesExternalContent: false,
    },
  };
}

/** The triage model answers the sender's question in prose — no outbound tool call. */
function proseRouter(answer: string): ModelRouter {
  return {
    async object() {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        object: { action: 'reply', reasoning: 'answer the question', steps: [], missingInfo: [] },
      };
    },
    async step(): Promise<StepCallOutcome> {
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: answer,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  } as unknown as ModelRouter;
}

/**
 * The known-sender reply child: on its first step it sends the drafted reply via
 * gmail.send (the body is parsed out of the seeded instruction, so the assertion
 * proves the draft flowed parent → child → tool). After the send resolves it
 * finishes in prose.
 */
function childRouter(threadId: string): ModelRouter {
  let step = 0;
  return {
    async object() {
      throw new Error('planner must be skipped for the pre-planned reply child');
    },
    async step(
      _role: string,
      opts: { messages: Array<{ role: string; content: unknown }> },
    ): Promise<StepCallOutcome> {
      step += 1;
      if (step === 1) {
        const userMsg = opts.messages.find((m) => m.role === 'user');
        const instruction = typeof userMsg?.content === 'string' ? userMsg.content : '';
        const body = instruction.split('Draft to send:\n')[1] ?? '';
        return {
          ok: true,
          modelId: 'fake/model',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'send-1',
              toolName: 'gmail.send',
              input: { to: [SENDER], subject: REPLY_SUBJECT, body, threadId },
            },
          ],
        };
      }
      return {
        ok: true,
        modelId: 'fake/model',
        degraded: false,
        text: 'Sent.',
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  } as unknown as ModelRouter;
}

async function newEmailConversation(trust: 'known' | 'unknown'): Promise<string> {
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust, title: SUBJECT })
    .returning({ id: conversations.id });
  const id = (conversation as NonNullable<typeof conversation>).id;
  createdConversationIds.push(id);
  return id;
}

async function childOf(parentTaskId: string): Promise<TaskRow | undefined> {
  const [child] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.type, 'adhoc')));
  if (child) createdTaskIds.push(child.id);
  return child;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('known-sender-reply.e2e: database unreachable — skipping');
  }
});

beforeEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  if (dbUp && createdConversationIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
  }
  if (dbUp && createdTaskIds.length) {
    // tool_calls.approval_id and approvals.tool_call_id reference each other;
    // break the cycle before deleting either.
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdConversationIds.length) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('D9 — known-sender email reply (integration, scripted model)', () => {
  it('proposes an approval-gated reply that sends the exact draft once approved', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newEmailConversation('known');
    const threadId = 'thread-known-approve';
    const answer = 'Thanks for reaching out — the report is on track and I will share it Friday.';

    const { task: parent } = await enqueueTask(db, {
      type: 'email_triage',
      event: emailEvent(conversationId, threadId, 'known', 'approve'),
      maxSteps: 8,
    });
    createdTaskIds.push(parent.id);

    // The triage task finishes with a plain answer (dashboard-only today).
    const parentOutcome = await executeTask(deps(proseRouter(answer)), parent.id);
    expect(parentOutcome.outcome).toBe('done');
    // No auto-send to the sender from the triage task itself.
    expect(sent).toHaveLength(0);

    // A known-sender reply child was deterministically enqueued.
    const child = await childOf(parent.id);
    expect(child).toBeDefined();
    const childTask = child as NonNullable<typeof child>;
    expect(childTask.trust).toBe('assistant');
    const childPayload = (childTask.trigger as { payload?: Record<string, unknown> }).payload ?? {};
    expect(childPayload.kind).toBe('known_sender_reply');
    expect(childPayload.to).toBe(SENDER);
    expect(childPayload.threadId).toBe(threadId);
    expect(childPayload.draft).toBe(answer);
    // Provenance carried forward so the child runs tainted (S1).
    expect(childPayload.taintedOrigin).toBe(true);

    // One router instance across both runs so its step counter (gmail.send on
    // step 1, prose after) survives the park/resume boundary.
    const reply = childRouter(threadId);

    // The child runs and PARKS on gmail.send — nothing is sent yet.
    const parked = await executeTask(deps(reply), childTask.id);
    expect(parked.outcome).toBe('parked');
    expect(sent).toHaveLength(0);

    // A pending approval bound to the exact gmail.send args exists.
    const [approval] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.taskId, childTask.id), eq(approvals.status, 'pending')));
    expect(approval).toBeDefined();
    const [sendCall] = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.taskId, childTask.id), eq(toolCalls.toolName, 'gmail.send')));
    expect(sendCall?.args).toEqual({
      to: [SENDER],
      subject: REPLY_SUBJECT,
      body: answer,
      threadId,
    });

    // Owner approves → the exact drafted reply is sent, exactly once.
    const resolved = await resolveApproval(db, {
      approvalId: (approval as NonNullable<typeof approval>).id,
      decision: 'approved',
      via: 'web',
      deferNotification: true,
    });
    expect(resolved.ok).toBe(true);

    const done = await executeTask(deps(reply), childTask.id);
    expect(done.outcome).toBe('done');
    expect(sent).toEqual([{ to: [SENDER], subject: REPLY_SUBJECT, body: answer, threadId }]);
  });

  it('sends nothing when the owner denies the proposed reply', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newEmailConversation('known');
    const threadId = 'thread-known-deny';
    const answer = 'Happy to help — let me look into that and get back to you.';

    const { task: parent } = await enqueueTask(db, {
      type: 'email_triage',
      event: emailEvent(conversationId, threadId, 'known', 'deny'),
      maxSteps: 8,
    });
    createdTaskIds.push(parent.id);
    await executeTask(deps(proseRouter(answer)), parent.id);

    const child = await childOf(parent.id);
    const childTask = child as NonNullable<typeof child>;
    expect(childTask).toBeDefined();

    const reply = childRouter(threadId);
    const parked = await executeTask(deps(reply), childTask.id);
    expect(parked.outcome).toBe('parked');

    const [approval] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.taskId, childTask.id), eq(approvals.status, 'pending')));
    const resolved = await resolveApproval(db, {
      approvalId: (approval as NonNullable<typeof approval>).id,
      decision: 'denied',
      via: 'web',
      deferNotification: true,
    });
    expect(resolved.ok).toBe(true);

    // The child resumes, records the denial, and finishes without sending.
    const done = await executeTask(deps(reply), childTask.id);
    expect(done.outcome).toBe('done');
    expect(sent).toHaveLength(0);
  });

  it('never proposes a reply for an unknown sender', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newEmailConversation('unknown');
    const threadId = 'thread-unknown';

    const { task: parent } = await enqueueTask(db, {
      type: 'email_triage',
      event: emailEvent(conversationId, threadId, 'unknown', 'unknown'),
      maxSteps: 8,
    });
    createdTaskIds.push(parent.id);

    const outcome = await executeTask(
      deps(proseRouter('I cannot help with that request.')),
      parent.id,
    );
    expect(outcome.outcome).toBe('done');

    const child = await childOf(parent.id);
    expect(child).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
