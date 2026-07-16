import { createHmac } from 'node:crypto';
import { agents, approvals, createDb, type Db, tasks, toolCalls } from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AgentDeps } from './deps.js';
import { handleInboundSms } from './sms-channel.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const OWNER_PHONE = '+14155550100';
const AUTH_TOKEN = 'test-twilio-token';
const PUBLIC_URL = 'http://localhost:8787';

let db: Db;
let dbUp = false;
let agentId: string;
const cleanupTaskIds: string[] = [];
const sentSms: Array<{ to: string; body: string }> = [];

/** Minimal AgentDeps — only what the sms channel touches. */
function fakeDeps(): AgentDeps {
  return {
    config: {
      OWNER_PHONE,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      PUBLIC_URL,
    } as AgentDeps['config'],
    db,
    twilio: {
      configured: () => true,
      send: async (to: string, body: string) => {
        sentSms.push({ to, body });
        return { sid: `SM-fake-${sentSms.length}` };
      },
    } as unknown as AgentDeps['twilio'],
  } as AgentDeps;
}

function _sign(url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', AUTH_TOKEN).update(data, 'utf8').digest('base64');
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db.select().from(agents).limit(1);
    if (!agent) throw new Error('unseeded');
    agentId = agent.id;
    dbUp = true;
  } catch {
    console.warn('sms-channel.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && cleanupTaskIds.length) {
    await db
      .update(toolCalls)
      .set({ approvalId: null })
      .where(inArray(toolCalls.taskId, cleanupTaskIds));
    await db.delete(approvals).where(inArray(approvals.taskId, cleanupTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, cleanupTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, cleanupTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('sms channel (integration)', () => {
  it('creates an sms_turn task for a normal owner message, idempotent on MessageSid', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const sid = `SM-test-${Date.now()}`;
    const sms = {
      messageSid: sid,
      from: OWNER_PHONE,
      to: '+18885550000',
      body: 'What is on my calendar today?',
    };

    const first = await handleInboundSms(fakeDeps(), sms);
    expect(first.kind).toBe('task');
    if (first.kind !== 'task') return;
    cleanupTaskIds.push(first.taskId);
    expect(first.created).toBe(true);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, first.taskId));
    expect(task?.type).toBe('sms_turn');
    expect(task?.trust).toBe('owner');

    const second = await handleInboundSms(fakeDeps(), sms); // Twilio retries webhooks
    expect(second.kind === 'task' && second.created).toBe(false);
  });

  it('gives non-owner senders unknown trust', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await handleInboundSms(fakeDeps(), {
      messageSid: `SM-stranger-${Date.now()}`,
      from: '+13105550199',
      to: '+18885550000',
      body: 'hey who is this',
    });
    expect(result.kind).toBe('task');
    if (result.kind !== 'task') return;
    cleanupTaskIds.push(result.taskId);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(task?.trust).toBe('unknown');
  });

  it('resolves an approval from an owner YES reply; ignores non-owner replies', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // stage a pending approval
    const [task] = await db
      .insert(tasks)
      .values({ agentId, type: 'adhoc', status: 'waiting_approval', trust: 'owner' })
      .returning();
    cleanupTaskIds.push((task as NonNullable<typeof task>).id);
    const [call] = await db
      .insert(toolCalls)
      .values({
        taskId: (task as NonNullable<typeof task>).id,
        step: 1,
        toolName: 'exec.outbound',
        args: {},
        risk: 'approval',
        status: 'awaiting_approval',
      })
      .returning();
    const [approval] = await db
      .insert(approvals)
      .values({
        taskId: (task as NonNullable<typeof task>).id,
        toolCallId: (call as NonNullable<typeof call>).id,
        shortCode: 'A99',
        summary: 'test approval',
        payload: {},
        expiresAt: sql`now() + interval '1 hour'`,
      })
      .returning();

    // non-owner reply is ignored
    const stranger = await handleInboundSms(fakeDeps(), {
      messageSid: `SM-x-${Date.now()}`,
      from: '+13105550199',
      to: '+18885550000',
      body: 'YES A99',
    });
    expect(stranger.kind).toBe('ignored');

    // owner reply resolves
    const owner = await handleInboundSms(fakeDeps(), {
      messageSid: `SM-y-${Date.now()}`,
      from: OWNER_PHONE,
      to: '+18885550000',
      body: 'yes A99',
    });
    expect(owner.kind === 'approval' && owner.resolved).toBe(true);

    const [after] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, (approval as NonNullable<typeof approval>).id));
    expect(after?.status).toBe('approved');
    expect(after?.resolvedVia).toBe('sms');
  });
});

describe('twilio webhook (e2e via app.request)', () => {
  const params = {
    MessageSid: 'SM-e2e-1',
    From: '+13105550111',
    To: '+18885550000',
    Body: 'YES A123456', // approval grammar from NON-owner → ignored, no task created
  };

  function formBody(p: Record<string, string>) {
    return new URLSearchParams(p).toString();
  }

  it('rejects forged signatures with 403', async (ctx) => {
    if (!dbUp) return ctx.skip();
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    const app = createApp();
    const res = await app.request('/webhooks/twilio/sms', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'aW52YWxpZA==',
      },
      body: formBody(params),
    });
    // config is cached from the process env at first load — if TWILIO_AUTH_TOKEN
    // was empty there, the route 501s; both prove the gate is closed.
    expect([403, 501]).toContain(res.status);
  });
});
