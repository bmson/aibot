import { conversations, createDb, type Db, messages, type TaskRow, tasks } from '@assistant/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKGROUND_NOTICE_MARKER, getAgent } from '../../chat.js';
import { seedContext } from './seed.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/**
 * The bug this covers: a fired reminder and a pulse alert land in the owner's
 * primary thread, which is the same thread they chat in. Seeded as bare
 * assistant turns they are indistinguishable from replies, so a question about
 * birthdays came back as the birthday list plus that morning's reminder and
 * calendar alert read back to the owner.
 */
describe('seedContext background notices', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const conversationIds: string[] = [];
  const taskIds: string[] = [];

  async function makeTask(type: string, conversationId: string): Promise<string> {
    const [row] = await db
      .insert(tasks)
      .values({ agentId, type, status: 'done', trust: 'owner', conversationId })
      .returning({ id: tasks.id });
    const id = (row as NonNullable<typeof row>).id;
    taskIds.push(id);
    return id;
  }

  async function addMessage(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    text: string;
    at: Date;
    taskId?: string;
    parts?: unknown[];
  }): Promise<void> {
    await db.insert(messages).values({
      conversationId: input.conversationId,
      role: input.role,
      origin: input.role === 'user' ? 'owner' : 'assistant',
      parts: input.parts ?? [{ type: 'text', text: input.text }],
      text: input.text,
      createdAt: input.at,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('background-notice.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
    }
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    if (conversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
  });

  it('marks delivered notices and leaves ordinary replies alone', async () => {
    if (!dbUp) return;
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'xtest-notice' })
      .returning({ id: conversations.id });
    const conversationId = (conv as NonNullable<typeof conv>).id;
    conversationIds.push(conversationId);

    const chatTask = await makeTask('chat_turn', conversationId);
    const pulseTask = await makeTask('scheduled', conversationId);
    const reminderTask = await makeTask('scheduled', conversationId);

    await addMessage({
      conversationId,
      role: 'user',
      text: 'what is the wifi password',
      at: new Date('2026-09-03T08:00:00Z'),
    });
    await addMessage({
      conversationId,
      role: 'assistant',
      text: 'It is hunter2.',
      at: new Date('2026-09-03T08:00:05Z'),
      taskId: chatTask,
    });
    // The pulse says what it is in its parts.
    await addMessage({
      conversationId,
      role: 'assistant',
      text: '"Fall Practice" starts in 30 minutes at Crocker Amazon.',
      at: new Date('2026-09-03T08:30:00Z'),
      taskId: pulseTask,
      parts: [
        { type: 'text', text: '"Fall Practice" starts in 30 minutes at Crocker Amazon.' },
        { type: 'data-card', data: { kind: 'proactive-alert', id: 'event-lead:1' } },
      ],
    });
    // A fired reminder does not — only its owning task type separates it.
    await addMessage({
      conversationId,
      role: 'assistant',
      text: 'Attend Clay technical interview',
      at: new Date('2026-09-03T08:45:00Z'),
      taskId: reminderTask,
    });
    await addMessage({
      conversationId,
      role: 'user',
      text: "who's birthdays are coming up?",
      at: new Date('2026-09-03T09:00:00Z'),
    });

    const window = await seedContext(db, {
      conversationId,
      trust: 'owner',
      type: 'chat_turn',
      trigger: {},
    } as TaskRow);
    const content = window.map((m) => String(m.content));

    expect(content).toContain('It is hunter2.');
    expect(content).toContain("who's birthdays are coming up?");
    expect(content.find((text) => text.includes('Fall Practice'))).toContain(
      BACKGROUND_NOTICE_MARKER,
    );
    expect(content.find((text) => text.includes('Attend Clay technical interview'))).toContain(
      BACKGROUND_NOTICE_MARKER,
    );
  });
});
