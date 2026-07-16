import { createDb, type Db, tasks } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChatTask, ensureChatConversation, getAgent } from '../chat.js';
import { ModelRouter } from './router.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    await getAgent(db);
    dbUp = true;
  } catch {
    console.warn('router.test: database unreachable or unseeded — skipping integration tests');
  }
});

afterAll(async () => {
  // postgres.js keeps the process alive otherwise
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('ModelRouter.route (integration)', () => {
  it('resolves a role to its seeded primary model', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('classify');
    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.modelId).toBe('qwen/qwen3-30b-a3b-instruct-2507');
      expect(route.degraded).toBe(false);
    }
  });

  it('honors an enabled model override', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { modelOverride: 'openai/gpt-oss-120b' });
    expect(route.ok && route.modelId).toBe('openai/gpt-oss-120b');
  });

  it('ignores an unknown model override and keeps the role primary', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { modelOverride: 'nope/not-a-model' });
    expect(route.ok && route.modelId).toBe('deepseek/deepseek-chat');
  });

  it('parks a task whose budget is exhausted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.0010', spentUsd: '0.0010' })
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { taskId: task.id });
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.decision.mode).toBe('park');

    await db.delete(tasks).where(eq(tasks.id, task.id));
  });

  it('degrades to the fallback model above the soft threshold', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.25', spentUsd: '0.21' }) // 84% > 80% soft
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { taskId: task.id });
    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.degraded).toBe(true);
      expect(route.modelId).toBe('openai/gpt-oss-120b'); // draft fallback
    }

    await db.delete(tasks).where(eq(tasks.id, task.id));
  });
});
