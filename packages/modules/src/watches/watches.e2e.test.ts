import { conversations, createDb, type Db, messages, watches, watchFires } from '@assistant/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noopOwnerNotifier } from '../platform.js';
import { matchEmailWatches, reapExpiredWatches, type WatchesDeps } from './email-watches.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const RUN = `Xtest-Watch-${Date.now()}`;
const NOW = new Date('2026-07-18T12:00:00.000Z');

let db: Db;
let dbUp = false;
let agentId: string;
let deps: WatchesDeps;

interface WatchInput {
  senders?: string[];
  keywords?: string[];
  maxFires?: number | null;
  expiresAt?: Date;
}

async function createEmailWatch(name: string, input: WatchInput = {}) {
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, channel: 'chat', trust: 'owner', title: `${RUN} ${name}` })
    .returning();
  if (!conversation) throw new Error('conversation insert failed');
  const [watch] = await db
    .insert(watches)
    .values({
      agentId,
      conversationId: conversation.id,
      kind: 'email',
      tier: 'notify',
      name: `${RUN} ${name}`,
      match: {
        expectedSenderEmails: input.senders ?? ['recruiter@acme.example'],
        ...(input.keywords ? { keywords: input.keywords } : {}),
      },
      maxFires: input.maxFires ?? null,
      expiresAt: input.expiresAt ?? new Date(NOW.getTime() + 30 * 24 * 60 * 60_000),
    })
    .returning();
  if (!watch) throw new Error('watch insert failed');
  return { watch, conversationId: conversation.id };
}

function email(overrides: Partial<Parameters<typeof matchEmailWatches>[1]> = {}) {
  return {
    agentId,
    messageId: `${RUN}-msg-1`,
    from: 'recruiter@acme.example',
    subject: 'Your interview',
    body: 'Details inside.',
    authenticated: true,
    now: NOW,
    ...overrides,
  };
}

async function fireCountFor(watchId: string) {
  const [row] = await db.select().from(watches).where(eq(watches.id, watchId));
  const fires = await db.select().from(watchFires).where(eq(watchFires.watchId, watchId));
  return { status: row?.status, fireCount: row?.fireCount, fires: fires.length };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db.query.agents.findMany({ limit: 1 });
    if (!agent) throw new Error('unseeded');
    agentId = agent.id;
    deps = { db, notifyOwner: noopOwnerNotifier.notifyOwner };
    dbUp = true;
  } catch {
    console.warn('watches.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (!dbUp) return;
  const rows = await db
    .select({ id: watches.id })
    .from(watches)
    .where(like(watches.name, `${RUN}%`));
  const ids = rows.map((row) => row.id);
  if (ids.length) await db.delete(watchFires).where(inArray(watchFires.watchId, ids));
  const convos = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(like(conversations.title, `${RUN}%`));
  const convoIds = convos.map((row) => row.id);
  if (convoIds.length) await db.delete(messages).where(inArray(messages.conversationId, convoIds));
  await db.delete(watches).where(like(watches.name, `${RUN}%`));
  await db.delete(conversations).where(like(conversations.title, `${RUN}%`));
});

describe('inbox watchers (notify tier)', () => {
  it('fires once on an authenticated match and posts a notice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch, conversationId } = await createEmailWatch('basic', { keywords: ['interview'] });
    const result = await matchEmailWatches(deps, email());
    expect(result.fired).toContain(watch.id);

    const state = await fireCountFor(watch.id);
    expect(state).toMatchObject({ status: 'active', fireCount: 1, fires: 1 });

    const notices = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.origin, 'assistant')));
    expect(notices.length).toBe(1);
    expect(notices[0]?.text).toContain('basic');
  });

  it('does not double-fire when the same message is replayed', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('replay', { keywords: ['interview'] });
    await matchEmailWatches(deps, email({ messageId: `${RUN}-replay` }));
    await matchEmailWatches(deps, email({ messageId: `${RUN}-replay` }));
    expect(await fireCountFor(watch.id)).toMatchObject({ fireCount: 1, fires: 1 });
  });

  it('ignores unauthenticated mail and senders the owner never named', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('gated', { keywords: ['interview'] });
    await matchEmailWatches(deps, email({ messageId: `${RUN}-unauth`, authenticated: false }));
    await matchEmailWatches(
      deps,
      email({ messageId: `${RUN}-wrong`, from: 'stranger@nowhere.example' }),
    );
    expect(await fireCountFor(watch.id)).toMatchObject({ fireCount: 0, fires: 0 });
  });

  it('exhausts a bounded watch after maxFires and stops firing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('bounded', { maxFires: 1 });
    await matchEmailWatches(deps, email({ messageId: `${RUN}-b1` }));
    const afterFirst = await fireCountFor(watch.id);
    expect(afterFirst).toMatchObject({ status: 'fired', fireCount: 1 });
    // A second, distinct message must not fire an exhausted watch.
    await matchEmailWatches(deps, email({ messageId: `${RUN}-b2` }));
    expect(await fireCountFor(watch.id)).toMatchObject({ fireCount: 1 });
  });

  it('reaps an expired watch and never fires it late', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('expired', {
      keywords: ['interview'],
      expiresAt: new Date(NOW.getTime() - 60_000),
    });
    const reaped = await reapExpiredWatches(deps, NOW);
    expect(reaped).toBeGreaterThanOrEqual(1);
    await matchEmailWatches(deps, email({ messageId: `${RUN}-late` }));
    expect(await fireCountFor(watch.id)).toMatchObject({ status: 'expired', fireCount: 0 });
  });
});
