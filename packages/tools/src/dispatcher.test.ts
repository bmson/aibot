import {
  agents,
  approvalPolicies,
  approvals,
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
    expect(outcome.kind === 'rejected' && outcome.reason).toMatch(/untrusted/);
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
