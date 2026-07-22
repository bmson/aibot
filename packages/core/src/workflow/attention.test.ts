import { conversations, createDb, type Db, messages, tasks } from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { renotifyStalledAttention } from './attention.js';
import { enqueueTask, markAttentionNotified, wakeTask } from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('renotifyStalledAttention', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let conversationId: string;
  const taskIds: string[] = [];

  /** Create a task already parked for the owner, with a controllable age + stamp. */
  async function parkedTask(opts: {
    status: 'needs_attention' | 'waiting_event';
    progress: string;
    updatedMinutesAgo: number;
    notified: boolean;
    withConversation?: boolean;
  }): Promise<string> {
    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'assistant', payload: { note: 'xtest-attn' } },
      type: 'adhoc',
    });
    await db
      .update(tasks)
      .set({
        status: opts.status,
        progress: opts.progress,
        title: 'xtest task',
        conversationId: opts.withConversation === false ? null : conversationId,
        attentionNotifiedAt: opts.notified ? sql`now()` : null,
        updatedAt: sql`now() - make_interval(mins => ${opts.updatedMinutesAgo})`,
      })
      .where(eq(tasks.id, task.id));
    taskIds.push(task.id);
    return task.id;
  }

  async function messageCount(taskId: string): Promise<number> {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.taskId, taskId));
    return rows.length;
  }

  async function stamp(taskId: string): Promise<Date | null> {
    const [row] = await db
      .select({ at: tasks.attentionNotifiedAt })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    return row?.at ?? null;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      const [conv] = await db
        .insert(conversations)
        .values({ agentId, channel: 'chat', title: 'xtest-attn-conv' })
        .returning({ id: conversations.id });
      conversationId = conv?.id ?? '';
      dbUp = true;
    } catch {
      console.warn('attention.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (taskIds.length) {
      await db.delete(messages).where(inArray(messages.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (conversationId) {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  });

  it('notifies and stamps a stale, unnotified needs_attention task', async () => {
    if (!dbUp) return;
    const id = await parkedTask({
      status: 'needs_attention',
      progress: 'attempt 8 failed: boom',
      updatedMinutesAgo: 30,
      notified: false,
    });
    const count = await renotifyStalledAttention(db, undefined, { olderThanMinutes: 5 });
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await messageCount(id)).toBe(1);
    expect(await stamp(id)).not.toBeNull();
  });

  it('skips a task still within the grace window', async () => {
    if (!dbUp) return;
    const id = await parkedTask({
      status: 'needs_attention',
      progress: 'just parked',
      updatedMinutesAgo: 1,
      notified: false,
    });
    await renotifyStalledAttention(db, undefined, { olderThanMinutes: 5 });
    expect(await messageCount(id)).toBe(0);
    expect(await stamp(id)).toBeNull();
  });

  it('skips an already-notified task', async () => {
    if (!dbUp) return;
    const id = await parkedTask({
      status: 'needs_attention',
      progress: 'already told them',
      updatedMinutesAgo: 30,
      notified: true,
    });
    await renotifyStalledAttention(db, undefined, { olderThanMinutes: 5 });
    expect(await messageCount(id)).toBe(0);
  });

  it('leaves the row unstamped when delivery throws', async () => {
    if (!dbUp) return;
    // No conversation and a throwing owner push → nothing reached the owner.
    const id = await parkedTask({
      status: 'needs_attention',
      progress: 'undeliverable',
      updatedMinutesAgo: 30,
      notified: false,
      withConversation: false,
    });
    const count = await renotifyStalledAttention(
      db,
      async () => {
        throw new Error('push down');
      },
      { olderThanMinutes: 5 },
    );
    // This task contributed nothing and stays sweep-eligible.
    expect(await stamp(id)).toBeNull();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('uses a paused-mission message for waiting_event', async () => {
    if (!dbUp) return;
    const id = await parkedTask({
      status: 'waiting_event',
      progress: 'paused after reflection',
      updatedMinutesAgo: 30,
      notified: false,
    });
    await renotifyStalledAttention(db, undefined, { olderThanMinutes: 5 });
    const [row] = await db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.taskId, id));
    expect(row?.text ?? '').toContain('paused');
    expect(await stamp(id)).not.toBeNull();
  });

  it('wakeTask clears the notified stamp so a re-park re-arms the sweep', async () => {
    if (!dbUp) return;
    const id = await parkedTask({
      status: 'needs_attention',
      progress: 'stamped then woken',
      updatedMinutesAgo: 30,
      notified: true,
    });
    expect(await stamp(id)).not.toBeNull();
    await wakeTask(db, id);
    expect(await stamp(id)).toBeNull();
    // markAttentionNotified only stamps rows still waiting on the owner.
    const stampedWhilePending = await markAttentionNotified(db, id);
    expect(stampedWhilePending).toBe(false);
  });
});
