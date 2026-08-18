import { conversations, createDb, type Db, emailIngest, messages } from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { runBriefing } from './briefing.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-briefing-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const ingestIds: string[] = [];

/** Records what the composer was given, and echoes a fixed digest back. */
function recordingRouter() {
  const prompts: string[] = [];
  const router = {
    async object(_role: string, opts: { prompt?: string }) {
      prompts.push(opts.prompt ?? '');
      return {
        ok: true,
        modelId: 'fake',
        degraded: false,
        object: { text: `${MARKER} composed digest` },
      };
    },
  } as unknown as ModelRouter;
  return { router, prompts };
}

async function addMail(input: {
  id: string;
  importance: number;
  category: string;
  subject: string;
  dates?: Array<{ iso: string; what: string }>;
}) {
  const [row] = await db
    .insert(emailIngest)
    .values({
      agentId,
      conversationId,
      channelMessageId: `gmail:${MARKER}-${input.id}`,
      fromEmail: 'bookings@airline.example',
      subject: input.subject,
      contentTrust: 'unknown',
      authenticated: true,
      category: input.category,
      importance: input.importance,
      actionable: true,
      reason: 'test reason',
      dates: input.dates ?? [],
    })
    .returning({ id: emailIngest.id });
  if (row) ingestIds.push(row.id);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('briefing.test: database unreachable — skipping');
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust: 'unknown', title: `${MARKER} thread` })
    .returning();
  conversationId = (conv as NonNullable<typeof conv>).id;
});

afterAll(async () => {
  if (dbUp) {
    if (ingestIds.length) await db.delete(emailIngest).where(inArray(emailIngest.id, ingestIds));
    await db.delete(messages).where(like(messages.text, `%${MARKER}%`));
    if (conversationId) {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('runBriefing', () => {
  it('says nothing when there is nothing to say', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A daily "nothing to report" trains the owner to ignore the thread the
    // real ones arrive in, so silence is the correct output, not a courtesy.
    const { router, prompts } = recordingRouter();
    const result = await runBriefing({ db, router });
    if (result.highlights === 0 && result.needsAttention === 0 && result.pendingApprovals === 0) {
      expect(result.delivered).toBe(false);
      expect(prompts).toHaveLength(0);
    } else {
      // A shared dev database can hold unrelated rows; the assertion above only
      // means anything on a quiet one.
      ctx.skip();
    }
  });

  it('delivers a digest built only from the structured rows', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    await addMail({
      id: 'flight',
      importance: 4,
      category: 'travel',
      subject: `${MARKER} Your itinerary`,
      dates: [{ iso: soon, what: 'flight departs' }],
    });
    await addMail({
      id: 'bulk',
      importance: 1,
      category: 'bulk',
      subject: `${MARKER} Summer sale`,
    });

    const { router, prompts } = recordingRouter();
    const result = await runBriefing({ db, router });

    expect(result.delivered).toBe(true);
    const prompt = prompts[0] ?? '';
    // Everything the model sees is a row we assembled — it is asked to write
    // notes up, never to decide what matters.
    expect(prompt).toContain(`${MARKER} Your itinerary`);
    expect(prompt).toContain('flight departs');
    // Routine mail is counted but not itemised.
    expect(prompt).not.toContain(`${MARKER} Summer sale`);

    const [posted] = await db
      .select({ text: messages.text })
      .from(messages)
      .where(eq(messages.text, `${MARKER} composed digest`));
    expect(posted).toBeDefined();
  });

  it('still delivers the notes when the composer cannot structure a digest', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The assembled rows ARE the substance; a composer outage should cost
    // polish, not the briefing. The name matters — isUnparseableObjectError
    // matches the AI SDK's error, and only that one degrades rather than throws.
    const failing = {
      async object() {
        throw Object.assign(new Error('no object generated'), {
          name: 'AI_NoObjectGeneratedError',
        });
      },
    } as unknown as ModelRouter;

    const result = await runBriefing({ db, router: failing });
    expect(result.delivered).toBe(true);

    const posted = await db
      .select({ text: messages.text })
      .from(messages)
      .where(like(messages.text, `%${MARKER} Your itinerary%`));
    // The raw notes went out, carrying the same items the composed version had.
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });
});
