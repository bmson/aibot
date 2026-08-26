import {
  agents,
  type CommitmentRow,
  commitments,
  conversations,
  createDb,
  type Db,
  messages,
} from '@assistant/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import {
  correctCommitment,
  dismissCommitment,
  extractCommitments,
  renderOpenCommitments,
  resolveCommitment,
  snoozeCommitment,
} from './commitments.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-commitment-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
let resolvedTitles: string[] = [];
let extractedCommitments: Array<{
  kind: 'question';
  title: string;
  details: string;
  nextAction: string;
  dueAt: string;
  confidence: number;
}> = [];

const fakeRouter = {
  async object(_role: string, opts: { prompt?: string }) {
    const relevant = opts.prompt?.includes(MARKER);
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        commitments: relevant ? extractedCommitments : [],
        resolvedTitles: relevant ? resolvedTitles : [],
      },
    };
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Commitment Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: MARKER })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('test conversation was not created');
    conversationId = conversation.id;
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text: `${MARKER}: keep tracking the travel decision until I confirm it is complete.`,
    });
    dbUp = true;
  } catch {
    console.warn('commitments.test: database unreachable — integration cases skipped');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

function row(overrides: Partial<CommitmentRow> = {}): CommitmentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    sourceMessageId: null,
    sourceTaskId: null,
    kind: 'question',
    title: 'Confirm the travel dates',
    details: '',
    nextAction: 'Choose between Thursday and Friday',
    status: 'open',
    dueAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.95',
    contentHash: 'hash',
    createdAt: new Date('2026-08-25T00:00:00Z'),
    updatedAt: new Date('2026-08-25T00:00:00Z'),
    ...overrides,
  };
}

describe('open-loop rendering', () => {
  it('renders a bounded, instruction-free continuity block', () => {
    const rendered = renderOpenCommitments([row({ dueAt: new Date('2026-08-30T00:00:00Z') })]);
    expect(rendered).toContain('Open loops from earlier owner conversations');
    expect(rendered).toContain('[question] Confirm the travel dates');
    expect(rendered).toContain('Next: Choose between Thursday and Friday');
    expect(rendered).toContain('due 2026-08-30');
    expect(rendered.length).toBeLessThanOrEqual(1400);
  });

  it('does not render an empty block', () => {
    expect(renderOpenCommitments([])).toBe('');
  });
});

describe('commitment lifecycle', () => {
  it('does not resolve a merely overlapping title, but resolves one exact title', async () => {
    if (!dbUp) return;
    const iceland = `${MARKER} Confirm travel dates for Iceland`;
    const japan = `${MARKER} Confirm travel dates for Japan`;
    await db.insert(commitments).values([
      {
        agentId,
        conversationId,
        kind: 'question',
        title: iceland,
        contentHash: `${MARKER}-iceland`,
      },
      {
        agentId,
        conversationId,
        kind: 'question',
        title: japan,
        contentHash: `${MARKER}-japan`,
      },
    ]);

    resolvedTitles = [`${MARKER} Confirm travel dates`];
    await extractCommitments({ db, router: fakeRouter }, { agentId });
    let rows = await db
      .select({ title: commitments.title, status: commitments.status })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.kind, 'question')));
    expect(rows.filter((item) => [iceland, japan].includes(item.title))).toEqual(
      expect.arrayContaining([
        { title: iceland, status: 'open' },
        { title: japan, status: 'open' },
      ]),
    );

    resolvedTitles = [iceland];
    await extractCommitments({ db, router: fakeRouter }, { agentId });
    rows = await db
      .select({ title: commitments.title, status: commitments.status })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.kind, 'question')));
    expect(rows.find((item) => item.title === iceland)?.status).toBe('resolved');
    expect(rows.find((item) => item.title === japan)?.status).toBe('open');
  });

  it('allows the same loop to recur after the previous occurrence is resolved', async () => {
    if (!dbUp) return;
    const title = `${MARKER} Choose the final itinerary`;
    resolvedTitles = [];
    extractedCommitments = [
      {
        kind: 'question',
        title,
        details: 'Pick one itinerary before booking.',
        nextAction: 'Choose option A or B',
        dueAt: '',
        confidence: 0.95,
      },
    ];

    await extractCommitments({ db, router: fakeRouter }, { agentId });
    const [first] = await db
      .select({ id: commitments.id })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.title, title)));
    if (!first) throw new Error('first commitment occurrence was not created');
    expect(await resolveCommitment(db, agentId, first.id, 'Completed in test')).toBe(true);

    await extractCommitments({ db, router: fakeRouter }, { agentId });
    const occurrences = await db
      .select({ status: commitments.status })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.title, title)));
    expect(occurrences.map((item) => item.status).sort()).toEqual(['open', 'resolved']);
  });

  it('does not mutate a commitment through another agent id', async () => {
    if (!dbUp) return;
    const [target] = await db
      .select({ id: commitments.id, status: commitments.status })
      .from(commitments)
      .where(eq(commitments.agentId, agentId));
    if (!target) throw new Error('test commitment was not created');

    expect(
      await resolveCommitment(db, '00000000-0000-0000-0000-000000000000', target.id, 'nope'),
    ).toBe(false);
    const [unchanged] = await db
      .select({ status: commitments.status })
      .from(commitments)
      .where(eq(commitments.id, target.id));
    expect(unchanged?.status).toBe(target.status);
  });

  it('does not reopen or edit a closed commitment through a stale action', async () => {
    if (!dbUp) return;
    const title = `${MARKER} Closed state is immutable`;
    const [target] = await db
      .insert(commitments)
      .values({
        agentId,
        conversationId,
        kind: 'promise',
        title,
        details: 'Original details',
        contentHash: `${MARKER}-closed-state`,
      })
      .returning({ id: commitments.id });
    if (!target) throw new Error('closed-state test commitment was not created');

    expect(await resolveCommitment(db, agentId, target.id, 'Completed in test')).toBe(true);
    expect(
      await snoozeCommitment(db, agentId, target.id, new Date(Date.now() + 24 * 3600 * 1000)),
    ).toBe(false);
    expect(await dismissCommitment(db, agentId, target.id)).toBe(false);
    expect(
      await correctCommitment(db, agentId, target.id, {
        title: `${title} edited`,
        details: 'Changed details',
      }),
    ).toBe(false);

    const [unchanged] = await db
      .select({
        status: commitments.status,
        title: commitments.title,
        details: commitments.details,
      })
      .from(commitments)
      .where(eq(commitments.id, target.id));
    expect(unchanged).toEqual({ status: 'resolved', title, details: 'Original details' });
  });
});
