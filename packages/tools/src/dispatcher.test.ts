import {
  agents,
  approvalPolicies,
  approvals,
  costEvents,
  costReservations,
  createDb,
  type Db,
  rateLimits,
  type TaskRow,
  tasks,
  toolCache,
  toolCalls,
} from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolDispatcher } from './dispatcher.js';
import { ToolRegistry } from './registry.js';
import { AmbiguousTwilioDeliveryError } from './twilio/client.js';
import type { AssistantTool, ToolContext } from './types.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const cleanupTaskIds: string[] = [];
let executions: Record<string, number> = {};

function makeTool(name: string, overrides: Partial<AssistantTool> = {}): AssistantTool {
  return {
    name,
    description: `test ${name}`,
    inputSchema: z.object({
      value: z.string().optional(),
      attendees: z.array(z.string()).optional(),
    }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args) => {
      executions[name] = (executions[name] ?? 0) + 1;
      return { echoed: (args as { value?: string }).value ?? null };
    },
    ...overrides,
  };
}

async function makeTask(trust: 'owner' | 'known' | 'unknown' | 'assistant'): Promise<TaskRow> {
  const [task] = await db
    .insert(tasks)
    .values({ agentId, type: 'adhoc', status: 'running', trust })
    .returning();
  if (!task) throw new Error('task insert failed');
  cleanupTaskIds.push(task.id);
  return task;
}

function ctxFor(task: TaskRow): ToolContext {
  return {
    taskId: task.id,
    agentId,
    trust: task.trust as ToolContext['trust'],
    tainted: false,
    db,
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  };
}

const provenance = { plannerVersion: 1, promptVersion: 1, model: 'test/model' };

/** Remove all rows from previous (possibly crashed) runs of this suite. */
async function purgeTestResidue() {
  await db
    .delete(costEvents)
    .where(
      sql`${costEvents.taskId} IN (select distinct task_id from ${toolCalls} where ${toolCalls.toolName} LIKE 'test.%')`,
    );
  await db
    .delete(costReservations)
    .where(
      sql`${costReservations.taskId} IN (select distinct task_id from ${toolCalls} where ${toolCalls.toolName} LIKE 'test.%')`,
    );
  await db
    .update(toolCalls)
    .set({ approvalId: null })
    .where(sql`${toolCalls.toolName} LIKE 'test.%'`);
  await db
    .delete(approvals)
    .where(
      sql`${approvals.toolCallId} IN (select id from ${toolCalls} where ${toolCalls.toolName} LIKE 'test.%')`,
    );
  await db.delete(toolCalls).where(sql`${toolCalls.toolName} LIKE 'test.%'`);
  await db.delete(toolCache).where(sql`${toolCache.toolName} LIKE 'test.%'`);
  await db.delete(rateLimits).where(eq(rateLimits.scope, 'tool:test.limited'));
  await db.delete(approvalPolicies).where(eq(approvalPolicies.toolName, 'test.calendar'));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('unseeded');
    agentId = agent.id;
    dbUp = true;
    await purgeTestResidue();
  } catch {
    console.warn('dispatcher.test: database unreachable — skipping');
  }
});

beforeEach(() => {
  executions = {};
});

afterAll(async () => {
  if (dbUp) {
    await purgeTestResidue();
    if (cleanupTaskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, cleanupTaskIds));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('ToolDispatcher (integration)', () => {
  it('rejects tools not in the trust-scoped registry (forbidden by construction)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(makeTool('test.send'), { outwardFacing: true });
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('unknown');

    const outcome = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.send',
      args: {},
      ctx: ctxFor(task),
      provenance,
    });
    expect(outcome.kind).toBe('rejected');
  });

  it('rejects tainted input for acceptsUntrustedInput: false tools', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.sensitive', { acceptsUntrustedInput: false }),
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('unknown');

    const outcome = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.sensitive',
      args: { value: 'x' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.reason).toMatch(/externally sourced/);
  });

  it('treats known-contact content as external for taint-sensitive tools', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.known-sensitive', { acceptsUntrustedInput: false }),
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('known');
    const outcome = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.known-sensitive',
      args: { value: 'external' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(outcome.kind).toBe('rejected');
  });

  it('rejects taint-sensitive tools after untrusted output enters an owner task', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.owner-sensitive', { acceptsUntrustedInput: false }),
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const outcome = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.owner-sensitive',
      args: { value: 'from a fetched page' },
      ctx: { ...ctxFor(task), tainted: true },
      provenance,
    });
    expect(outcome.kind).toBe('rejected');
  });

  it('requires approval for privileged reads and network egress in a tainted owner task', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry()
      .register(makeTool('test.private-read'), { confidentialRead: true })
      .register(makeTool('test.network-read'), {
        networkEgress: true,
        blanketAllowIneligible: true,
      });
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');
    const tainted = { ...ctxFor(task), tainted: true };

    const privateRead = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.private-read',
      args: {},
      ctx: tainted,
      provenance,
    });
    const networkRead = await dispatcher.dispatch({
      task,
      step: 2,
      toolName: 'test.network-read',
      args: {},
      ctx: tainted,
      provenance,
    });

    expect(privateRead.kind).toBe('awaiting_approval');
    expect(networkRead.kind).toBe('awaiting_approval');
    expect(executions['test.private-read']).toBeUndefined();
    expect(executions['test.network-read']).toBeUndefined();
  });

  it('executes autonomous tools and records decision provenance', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(makeTool('test.echo'));
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const outcome = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.echo',
      args: { value: 'hi' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.result).toEqual({ echoed: 'hi' });

    const [row] = await db.select().from(toolCalls).where(eq(toolCalls.id, outcome.toolCallId));
    expect(row?.status).toBe('succeeded');
    const decision = row?.decision as { promptVersion: number; model: string };
    expect(decision.promptVersion).toBe(1);
    expect(decision.model).toBe('test/model');
  });

  it('conservatively meters an ambiguous SMS outcome and suppresses retries', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let attempts = 0;
    const registry = new ToolRegistry().register(
      makeTool('test.ambiguous-sms', {
        idempotencyKey: (_args, toolCtx) => `test-ambiguous-sms-${toolCtx.taskId}`,
        estimateCost: () => ({
          source: 'twilio_sms',
          rateKey: 'twilio_sms',
          quantity: 1,
          description: 'test ambiguous SMS',
        }),
        execute: async () => {
          attempts += 1;
          throw new AmbiguousTwilioDeliveryError('response timed out after provider acceptance');
        },
      }),
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');
    const dispatch = () =>
      dispatcher.dispatch({
        task,
        step: 1,
        toolName: 'test.ambiguous-sms',
        args: {},
        ctx: ctxFor(task),
        provenance,
      });

    const first = await dispatch();
    const retry = await dispatch();
    expect(first).toMatchObject({
      kind: 'executed',
      result: { deliveryStatus: 'unknown', retrySuppressed: true },
    });
    expect(retry).toMatchObject({
      kind: 'executed',
      result: { deliveryStatus: 'unknown', retrySuppressed: true },
    });
    expect(attempts).toBe(1);

    const [call] = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolName, 'test.ambiguous-sms'));
    if (!call) throw new Error('ambiguous SMS tool call was not recorded');
    expect(call?.status).toBe('succeeded');
    const [event] = await db.select().from(costEvents).where(eq(costEvents.toolCallId, call.id));
    expect(event?.source).toBe('twilio_sms');
    expect(Number(event?.usd)).toBeGreaterThan(0);
  });

  it('parks approval-tier tools with an approval row and short code', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.outbound', {
        risk: 'approval',
        approvalSummary: (args) => `send "${(args as { value?: string }).value}"`,
      }),
      { outwardFacing: true },
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const outcome = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.outbound',
      args: { value: 'proposal' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(outcome.kind).toBe('awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;
    expect(outcome.shortCode).toMatch(/^A\d+$/);
    expect(outcome.summary).toBe('send "proposal"');
    expect(executions['test.outbound']).toBeUndefined(); // did NOT execute

    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, outcome.approvalId));
    expect(approval?.status).toBe('pending');
    expect(approval?.payload).toEqual({ value: 'proposal' });
  });

  it('never reuses a resolved approval short code', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.replay-safe-approval', { risk: 'approval' }),
      { outwardFacing: true },
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const first = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.replay-safe-approval',
      args: { value: 'first' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(first.kind).toBe('awaiting_approval');
    if (first.kind !== 'awaiting_approval') return;
    await db.update(approvals).set({ status: 'denied' }).where(eq(approvals.id, first.approvalId));

    const second = await dispatcher.dispatch({
      task,
      step: 2,
      toolName: 'test.replay-safe-approval',
      args: { value: 'second' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(second.kind).toBe('awaiting_approval');
    if (second.kind !== 'awaiting_approval') return;
    expect(second.shortCode).not.toBe(first.shortCode);
    expect(Number(second.shortCode.slice(1))).toBeGreaterThan(Number(first.shortCode.slice(1)));
  });

  it('executes an approved call once and returns the discriminated outcome', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.approved-once', { risk: 'approval' }),
      { outwardFacing: true },
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');
    const parked = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.approved-once',
      args: { value: 'go' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(parked.kind).toBe('awaiting_approval');
    if (parked.kind !== 'awaiting_approval') return;
    await db
      .update(approvals)
      .set({ status: 'approved' })
      .where(eq(approvals.id, parked.approvalId));
    await db
      .update(toolCalls)
      .set({ status: 'approved' })
      .where(eq(toolCalls.id, parked.toolCallId));

    const first = await dispatcher.executeApproved(parked.toolCallId, ctxFor(task));
    const retry = await dispatcher.executeApproved(parked.toolCallId, ctxFor(task));
    expect(first).toMatchObject({ kind: 'executed', result: { echoed: 'go' } });
    expect(retry).toMatchObject({ kind: 'executed', result: { echoed: 'go' } });
    expect(executions['test.approved-once']).toBe(1);
  });

  it('suppresses retries when an approved SMS has an ambiguous provider outcome', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let attempts = 0;
    const registry = new ToolRegistry().register(
      makeTool('test.approved-ambiguous-sms', {
        risk: 'approval',
        estimateCost: () => ({
          source: 'twilio_sms',
          rateKey: 'twilio_sms',
          quantity: 1,
          description: 'test approved ambiguous SMS',
        }),
        execute: async () => {
          attempts += 1;
          throw new AmbiguousTwilioDeliveryError('response timed out after provider acceptance');
        },
      }),
      { outwardFacing: true },
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');
    const parked = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.approved-ambiguous-sms',
      args: {},
      ctx: ctxFor(task),
      provenance,
    });
    expect(parked.kind).toBe('awaiting_approval');
    if (parked.kind !== 'awaiting_approval') return;
    await db
      .update(approvals)
      .set({ status: 'approved' })
      .where(eq(approvals.id, parked.approvalId));
    await db
      .update(toolCalls)
      .set({ status: 'approved' })
      .where(eq(toolCalls.id, parked.toolCallId));

    const first = await dispatcher.executeApproved(parked.toolCallId, ctxFor(task));
    const retry = await dispatcher.executeApproved(parked.toolCallId, ctxFor(task));
    expect(first).toMatchObject({
      kind: 'executed',
      result: { deliveryStatus: 'unknown', retrySuppressed: true },
    });
    expect(retry).toMatchObject({
      kind: 'executed',
      result: { deliveryStatus: 'unknown', retrySuppressed: true },
    });
    expect(attempts).toBe(1);

    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.toolCallId, parked.toolCallId));
    expect(event?.source).toBe('twilio_sms');
    expect(Number(event?.usd)).toBeGreaterThan(0);
  });

  it('keeps an approved call parked when its cost cannot be reserved', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.approved-budget', {
        risk: 'approval',
        estimateCost: () => ({
          source: 'cloud_run_job_sec',
          rateKey: 'cloud_run_job_sec',
          quantity: 100_000_000,
        }),
      }),
      { outwardFacing: true },
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');
    const parked = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.approved-budget',
      args: { value: 'too expensive' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(parked.kind).toBe('awaiting_approval');
    if (parked.kind !== 'awaiting_approval') return;
    await db
      .update(approvals)
      .set({ status: 'approved' })
      .where(eq(approvals.id, parked.approvalId));
    await db
      .update(toolCalls)
      .set({ status: 'approved' })
      .where(eq(toolCalls.id, parked.toolCallId));

    const outcome = await dispatcher.executeApproved(parked.toolCallId, ctxFor(task));
    expect(outcome.kind).toBe('budget_blocked');
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.id, parked.toolCallId));
    expect(call?.status).toBe('approved');
    expect(executions['test.approved-budget']).toBeUndefined();
  });

  it('a matching allow policy turns approval tier into autonomous, recorded in provenance', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.calendar', {
        risk: (args) =>
          ((args as { attendees?: string[] }).attendees?.length ?? 0) > 0 ? 'approval' : 'approval', // force approval so only the policy can allow it
      }),
    );
    await db.insert(approvalPolicies).values({
      agentId,
      toolName: 'test.calendar',
      templateKey: 'calendar.self_only_events',
      match: {},
      effect: 'allow',
      createdVia: 'seed',
    });

    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const selfOnly = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.calendar',
      args: { attendees: [] },
      ctx: ctxFor(task),
      provenance,
    });
    expect(selfOnly.kind).toBe('executed');
    if (selfOnly.kind === 'executed') {
      const [row] = await db.select().from(toolCalls).where(eq(toolCalls.id, selfOnly.toolCallId));
      const decision = (row?.decision ?? {}) as { policyId?: string };
      expect(decision.policyId).toBeTruthy();
    }

    const withAttendees = await dispatcher.dispatch({
      task,
      step: 2,
      toolName: 'test.calendar',
      args: { attendees: ['jon@x.is'] },
      ctx: ctxFor(task),
      provenance,
    });
    expect(withAttendees.kind).toBe('awaiting_approval'); // policy template doesn't match
  });

  it('idempotency: a crash-retry returns the recorded result without re-executing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const key = `idem-${Date.now()}`;
    const registry = new ToolRegistry().register(
      makeTool('test.idem', { idempotencyKey: () => key }),
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const first = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.idem',
      args: { value: 'once' },
      ctx: ctxFor(task),
      provenance,
    });
    const second = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.idem',
      args: { value: 'once' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(first.kind).toBe('executed');
    expect(second.kind).toBe('executed');
    expect(executions['test.idem']).toBe(1); // executed exactly once
    if (first.kind === 'executed' && second.kind === 'executed') {
      expect(second.result).toEqual(first.result);
    }
  });

  it('caches results for cacheTtlSeconds tools', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(makeTool('test.cached', { cacheTtlSeconds: 60 }));
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const first = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.cached',
      args: { value: 'same' },
      ctx: ctxFor(task),
      provenance,
    });
    const second = await dispatcher.dispatch({
      task,
      step: 2,
      toolName: 'test.cached',
      args: { value: 'same' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(first.kind === 'executed' && first.cached).toBe(false);
    expect(second.kind === 'executed' && second.cached).toBe(true);
    expect(executions['test.cached']).toBe(1);
  });

  it('enforces rate limits on autonomous executions', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db
      .insert(rateLimits)
      .values({ scope: 'tool:test.limited', maxPerHour: 1, maxPerDay: 10 })
      .onConflictDoNothing();
    const registry = new ToolRegistry().register(makeTool('test.limited'));
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const first = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.limited',
      args: { value: '1' },
      ctx: ctxFor(task),
      provenance,
    });
    const second = await dispatcher.dispatch({
      task,
      step: 2,
      toolName: 'test.limited',
      args: { value: '2' },
      ctx: ctxFor(task),
      provenance,
    });
    expect(first.kind).toBe('executed');
    expect(second.kind).toBe('rejected');
    expect(second.kind === 'rejected' && second.reason).toMatch(/rate limit/);
  });

  it('records failures and reports them as rejection', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const registry = new ToolRegistry().register(
      makeTool('test.boom', {
        execute: async () => {
          throw new Error('kaput');
        },
      }),
    );
    const dispatcher = new ToolDispatcher(db, registry);
    const task = await makeTask('owner');

    const outcome = await dispatcher.dispatch({
      task,
      step: 1,
      toolName: 'test.boom',
      args: {},
      ctx: ctxFor(task),
      provenance,
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.reason).toMatch(/kaput/);
  });
});
