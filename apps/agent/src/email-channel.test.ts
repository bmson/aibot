import { getAgent } from '@assistant/core';
import {
  channelBindings,
  conversations,
  createDb,
  type Db,
  type TaskRow,
  tasks,
} from '@assistant/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDeps } from './deps.js';
import { deliverEmailFinal } from './email-channel.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
let emailConvId: string;
let chatConvId: string;
const createdConversationIds: string[] = [];
const createdTaskIds: string[] = [];

/** Captures Gmail sends instead of performing them; serves Message-ID metadata reads. */
function makeDeps(): { deps: AgentDeps; sent: Array<{ url: string; body: string }> } {
  const sent: Array<{ url: string; body: string }> = [];
  const deps = {
    db,
    googleClient: {
      configured: () => true,
      api: async (url: string, init?: { body?: string }) => {
        if (url.includes('format=metadata')) {
          return { payload: { headers: [{ name: 'Message-ID', value: '<orig-123@mail>' }] } };
        }
        sent.push({ url, body: init?.body ?? '' });
        return { id: 'sent-1', threadId: 'thread-1' };
      },
    },
  } as unknown as AgentDeps;
  return { deps, sent };
}

function emailTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'email_triage',
    trust: 'owner',
    conversationId: emailConvId,
    trigger: {
      source: 'email',
      payload: {
        threadId: 'thread-1',
        messageId: 'msg-1',
        from: 'bmson@bmson.com',
        subject: 'Camp performance',
      },
    },
    ...overrides,
  } as TaskRow;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-channel.test: database unreachable — skipping');
    return;
  }
  const [emailConv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust: 'owner', title: 'email-channel-test' })
    .returning();
  const [chatConv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'chat', trust: 'owner', title: 'email-channel-test' })
    .returning();
  emailConvId = (emailConv as NonNullable<typeof emailConv>).id;
  chatConvId = (chatConv as NonNullable<typeof chatConv>).id;
  createdConversationIds.push(emailConvId, chatConvId);
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdConversationIds.length) {
    await db
      .delete(channelBindings)
      .where(inArray(channelBindings.conversationId, createdConversationIds));
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('deliverEmailFinal', () => {
  it('replies on the same Gmail thread for owner email tasks', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();

    const delivered = await deliverEmailFinal(deps, emailTask(), 'The performance is at 4pm.');
    expect(delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('/messages/send');

    const body = JSON.parse(sent[0]?.body ?? '{}') as { raw: string; threadId: string };
    expect(body.threadId).toBe('thread-1');
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toMatch(/From: "[^"]+" <bot@bmson\.com>/); // explicit display name, not the account profile name
    expect(decoded).toContain('To: bmson@bmson.com');
    expect(decoded).toContain('Subject: Re: Camp performance');
    expect(decoded).toContain('In-Reply-To: <orig-123@mail>');
    expect(decoded).toContain('The performance is at 4pm.');
  });

  it('never auto-replies to non-owner senders', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    const delivered = await deliverEmailFinal(
      deps,
      emailTask({ trust: 'unknown' }),
      'should not send',
    );
    expect(delivered).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('ignores non-email tasks and conversations', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    expect(await deliverEmailFinal(deps, emailTask({ type: 'chat_turn' }), 'no')).toBe(false);
    expect(await deliverEmailFinal(deps, emailTask({ conversationId: chatConvId }), 'no')).toBe(
      false,
    );
    expect(
      await deliverEmailFinal(
        deps,
        emailTask({ trigger: { source: 'email', payload: {} } as TaskRow['trigger'] }),
        'no',
      ),
    ).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('replies to the email thread for a follow-up (adhoc) task on the same conversation (D5)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A conversation started by email, with its thread binding and the original
    // authenticated email_triage task recorded.
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner', title: 'followup-thread' })
      .returning();
    const convId = (conv as NonNullable<typeof conv>).id;
    createdConversationIds.push(convId);
    await db.insert(channelBindings).values({
      conversationId: convId,
      channel: 'email',
      externalId: 'thread-followup',
    });
    const [origin] = await db
      .insert(tasks)
      .values({
        agentId,
        conversationId: convId,
        type: 'email_triage',
        trust: 'owner',
        trigger: {
          source: 'email',
          payload: {
            threadId: 'thread-followup',
            from: 'bmson@bmson.com',
            subject: 'Trip planning',
            rfcMessageId: '<orig-followup@mail>',
          },
        },
      })
      .returning();
    createdTaskIds.push((origin as NonNullable<typeof origin>).id);

    const { deps, sent } = makeDeps();
    // A mission/adhoc continuation carries no email payload of its own.
    const adhoc = {
      id: '00000000-0000-0000-0000-0000000000aa',
      type: 'adhoc',
      trust: 'owner',
      conversationId: convId,
      trigger: { source: 'internal', payload: {} },
    } as TaskRow;

    const delivered = await deliverEmailFinal(deps, adhoc, 'Booked the flights.');
    expect(delivered).toBe(true);
    const body = JSON.parse(sent[0]?.body ?? '{}') as { raw: string; threadId: string };
    expect(body.threadId).toBe('thread-followup');
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: bmson@bmson.com');
    expect(decoded).toContain('Subject: Re: Trip planning');
    expect(decoded).toContain('In-Reply-To: <orig-followup@mail>');
    expect(decoded).toContain('Booked the flights.');
  });

  it('keeps an existing Re: prefix', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    await deliverEmailFinal(
      deps,
      emailTask({
        trigger: {
          source: 'email',
          payload: { threadId: 'thread-1', from: 'bmson@bmson.com', subject: 'Re: Camp' },
        } as TaskRow['trigger'],
      }),
      'ok',
    );
    const decoded = Buffer.from(
      (JSON.parse(sent[0]?.body ?? '{}') as { raw: string }).raw,
      'base64url',
    ).toString('utf8');
    expect(decoded).toContain('Subject: Re: Camp');
    expect(decoded).not.toContain('Re: Re:');
  });
});
