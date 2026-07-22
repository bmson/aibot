import { costReservations, createDb, type Db, tasks } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChatTask, ensureChatConversation, getAgent } from '../chat.js';
import { BudgetReservationError, releaseReservation } from '../cost.js';
import { isUnparseableObjectError, ModelRouter } from './router.js';

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

describe('isUnparseableObjectError', () => {
  it('detects the AI SDK no-object error by name (either spelling)', () => {
    const sdk = new Error('No object generated: could not parse the response.');
    sdk.name = 'AI_NoObjectGeneratedError';
    expect(isUnparseableObjectError(sdk)).toBe(true);
    const alt = new Error('no object');
    alt.name = 'NoObjectGeneratedError';
    expect(isUnparseableObjectError(alt)).toBe(true);
  });

  it('is false for transient/provider errors and non-errors (they stay retryable)', () => {
    expect(isUnparseableObjectError(new Error('fetch failed'))).toBe(false);
    expect(isUnparseableObjectError(new BudgetReservationError('daily budget', new Date()))).toBe(
      false,
    );
    expect(isUnparseableObjectError('AI_NoObjectGeneratedError')).toBe(false);
    expect(isUnparseableObjectError(null)).toBe(false);
  });
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
      // OpenRouter must not route feature-dependent requests (json_schema,
      // tools) to providers that cannot honor them.
      const settings = (
        route.model as { settings?: { provider?: { require_parameters?: boolean } } }
      ).settings;
      expect(settings?.provider?.require_parameters).toBe(true);
    }
  });

  it('honors an enabled model override', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { modelOverride: 'openai/gpt-oss-120b' });
    expect(route.ok && route.modelId).toBe('openai/gpt-oss-120b');
  });

  it('uses the configured role fallback when a caller requires it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { forceFallback: true });
    expect(route.ok && route.modelId).toBe('openai/gpt-oss-120b');
    expect(route.ok && route.degraded).toBe(true);
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

  it('tries the cheaper fallback when the primary reservation does not fit', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.0200', spentUsd: '0' })
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'test-key-unused');
    const prepared = await (
      router as unknown as {
        prepareModelCall: (
          role: 'reason',
          opts: { taskId: string; prompt: string },
        ) => Promise<
          | { ok: false }
          | {
              ok: true;
              route: { modelId: string; degraded: boolean };
              reservationId: string;
            }
        >;
      }
    ).prepareModelCall('reason', { taskId: task.id, prompt: 'Finish the task.' });

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.route.modelId).toBe('deepseek/deepseek-chat');
      expect(prepared.route.degraded).toBe(true);
      await releaseReservation(db, prepared.reservationId);
    }
    await db.delete(costReservations).where(eq(costReservations.taskId, task.id));
    await db.delete(tasks).where(eq(tasks.id, task.id));
  });

  it('blocks embeddings before calling the provider when the task cap is exhausted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.0010', spentUsd: '0.0010' })
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'provider-must-not-be-called');
    await expect(router.embed(['budget guard'], { taskId: task.id })).rejects.toBeInstanceOf(
      BudgetReservationError,
    );
    await db.delete(tasks).where(eq(tasks.id, task.id));
  });
});
