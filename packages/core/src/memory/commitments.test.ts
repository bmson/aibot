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
  markStaleCommitments,
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

/**
 * The sweep runs against its own agent so it cannot retire rows the lifecycle
 * cases above are still asserting on, whatever order vitest picks.
 */
describe('retiring loops nobody is working on', () => {
  const now = new Date('2026-09-13T12:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);
  let sweepAgentId: string;
  let sweepConversationId: string;

  beforeAll(async () => {
    if (!dbUp) return;
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Sweep Test',
        email: `${MARKER}-sweep@example.com`,
        workspacePrefix: `${MARKER}-sweep`,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('sweep test agent was not created');
    sweepAgentId = agent.id;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId: sweepAgentId, channel: 'chat', trust: 'owner', title: `${MARKER}-sweep` })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('sweep test conversation was not created');
    sweepConversationId = conversation.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    // conversations.agent_id has no cascade, so the agent cannot go first.
    await db.delete(messages).where(eq(messages.conversationId, sweepConversationId));
    await db.delete(conversations).where(eq(conversations.id, sweepConversationId));
    await db.delete(agents).where(eq(agents.id, sweepAgentId));
  });

  async function seed(
    rows: Array<{
      key: string;
      kind: string;
      idleDays: number;
      status?: string;
      snoozedUntil?: Date | null;
      dueAt?: Date | null;
    }>,
  ) {
    await db.delete(commitments).where(eq(commitments.agentId, sweepAgentId));
    for (const item of rows) {
      await db.insert(commitments).values({
        agentId: sweepAgentId,
        conversationId: sweepConversationId,
        kind: item.kind,
        title: `${MARKER} ${item.key}`,
        status: item.status ?? 'open',
        snoozedUntil: item.snoozedUntil ?? null,
        dueAt: item.dueAt ?? null,
        contentHash: `${MARKER}-${item.key}`,
        updatedAt: daysAgo(item.idleDays),
      });
    }
  }

  async function statuses(): Promise<Record<string, string>> {
    const rows = await db
      .select({ title: commitments.title, status: commitments.status })
      .from(commitments)
      .where(eq(commitments.agentId, sweepAgentId));
    return Object.fromEntries(rows.map((row) => [row.title.replace(`${MARKER} `, ''), row.status]));
  }

  it('retires each kind on its own window rather than one blanket cutoff', async () => {
    if (!dbUp) return;
    await seed([
      { key: 'fresh-question', kind: 'question', idleDays: 10 },
      { key: 'cold-question', kind: 'question', idleDays: 31 },
      { key: 'waiting', kind: 'waiting_on', idleDays: 31 },
      { key: 'promise-inside-window', kind: 'promise', idleDays: 31 },
      { key: 'cold-promise', kind: 'promise', idleDays: 46 },
      { key: 'decision-inside-window', kind: 'decision', idleDays: 46 },
      { key: 'cold-decision', kind: 'decision', idleDays: 91 },
    ]);

    expect(await markStaleCommitments(db, sweepAgentId, now)).toBe(4);
    expect(await statuses()).toEqual({
      'fresh-question': 'open',
      'cold-question': 'stale',
      waiting: 'stale',
      'promise-inside-window': 'open',
      'cold-promise': 'stale',
      'decision-inside-window': 'open',
      'cold-decision': 'stale',
    });
  });

  it('retires a loop that blew past its own due date, however recently touched', async () => {
    if (!dbUp) return;
    await seed([
      { key: 'just-overdue', kind: 'promise', idleDays: 1, dueAt: daysAgo(13) },
      { key: 'long-overdue', kind: 'promise', idleDays: 1, dueAt: daysAgo(15) },
    ]);

    expect(await markStaleCommitments(db, sweepAgentId, now)).toBe(1);
    expect(await statuses()).toEqual({ 'just-overdue': 'open', 'long-overdue': 'stale' });
  });

  it('leaves a live snooze alone and retires one that has already run out', async () => {
    if (!dbUp) return;
    await seed([
      {
        key: 'snoozed-until-tomorrow',
        kind: 'question',
        idleDays: 60,
        status: 'snoozed',
        snoozedUntil: new Date(now.getTime() + 24 * 3600 * 1000),
      },
      {
        key: 'snooze-expired',
        kind: 'question',
        idleDays: 60,
        status: 'snoozed',
        snoozedUntil: daysAgo(2),
      },
    ]);

    expect(await markStaleCommitments(db, sweepAgentId, now)).toBe(1);
    expect(await statuses()).toEqual({
      'snoozed-until-tomorrow': 'snoozed',
      'snooze-expired': 'stale',
    });
  });

  it('never reopens a loop the owner already closed', async () => {
    if (!dbUp) return;
    await seed([
      { key: 'resolved', kind: 'question', idleDays: 200, status: 'resolved' },
      { key: 'dismissed', kind: 'question', idleDays: 200, status: 'dismissed' },
    ]);

    expect(await markStaleCommitments(db, sweepAgentId, now)).toBe(0);
    expect(await statuses()).toEqual({ resolved: 'resolved', dismissed: 'dismissed' });
  });

  it('does not let re-extraction of the same loop reset its idle clock', async () => {
    if (!dbUp) return;
    await db.delete(commitments).where(eq(commitments.agentId, sweepAgentId));
    await db.insert(messages).values({
      conversationId: sweepConversationId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text: `${MARKER}: the nightly pass keeps noticing this one.`,
    });
    const regenerated = {
      kind: 'question' as const,
      title: `${MARKER} a loop the nightly pass keeps regenerating`,
      details: '',
      nextAction: 'first reading',
      dueAt: '',
      confidence: 0.95,
    };
    extractedCommitments = [regenerated];
    resolvedTitles = [];
    await extractCommitments({ db, router: fakeRouter }, { agentId: sweepAgentId });

    const stale = daysAgo(45);
    await db
      .update(commitments)
      .set({ updatedAt: stale })
      .where(eq(commitments.agentId, sweepAgentId));

    // Same loop, newer detail: the row learns the detail, the clock does not move.
    extractedCommitments = [{ ...regenerated, nextAction: 'second reading' }];
    await extractCommitments({ db, router: fakeRouter }, { agentId: sweepAgentId });

    const [row] = await db
      .select({ nextAction: commitments.nextAction, updatedAt: commitments.updatedAt })
      .from(commitments)
      .where(eq(commitments.agentId, sweepAgentId));
    expect(row?.nextAction).toBe('second reading');
    expect(row?.updatedAt.getTime()).toBe(stale.getTime());
    expect(await markStaleCommitments(db, sweepAgentId, now)).toBe(1);

    extractedCommitments = [];
  });
});

describe('what extraction is allowed to see', () => {
  it('ignores the assistant talking to itself in a machinery thread', async () => {
    if (!dbUp) return;
    // Scheduled runs, the Notifications thread and document processing all get
    // trust 'assistant'. A schedule named daily-briefing becomes a task title
    // there, and used to come back as the owner's promise to complete it.
    const [machinery] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'chat',
        trust: 'assistant',
        title: `${MARKER}-machinery`,
      })
      .returning({ id: conversations.id });
    if (!machinery) throw new Error('machinery conversation was not created');
    await db.insert(messages).values({
      conversationId: machinery.id,
      role: 'assistant',
      origin: 'assistant',
      parts: [],
      text: `${MARKER}: running the daily-briefing schedule and preparing the owner's morning brief.`,
    });
    extractedCommitments = [
      {
        kind: 'question',
        title: `${MARKER} Complete daily-briefing`,
        details: '',
        nextAction: '',
        dueAt: '',
        confidence: 0.95,
      },
    ];
    resolvedTitles = [];

    await extractCommitments({ db, router: fakeRouter }, { agentId });

    const rows = await db
      .select({ conversationId: commitments.conversationId })
      .from(commitments)
      .where(and(eq(commitments.agentId, agentId), eq(commitments.conversationId, machinery.id)));
    expect(rows).toEqual([]);

    extractedCommitments = [];
    await db.delete(messages).where(eq(messages.conversationId, machinery.id));
    await db.delete(conversations).where(eq(conversations.id, machinery.id));
  });
});
