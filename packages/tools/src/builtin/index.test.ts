import { agents, createDb, type Db, goals } from '@assistant/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerBuiltinTools } from './index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('builtin trust capabilities', () => {
  it('does not expose owner-private reads or workspace writes to unknown tasks', () => {
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const unknown = registry.toolsForTask('unknown').map((tool) => tool.name);

    expect(unknown).not.toContain('memory.recall');
    expect(unknown).not.toContain('conversations.search');
    expect(unknown).not.toContain('goals.list');
    expect(unknown).not.toContain('workspace.read');
    expect(unknown).not.toContain('workspace.list');
    expect(unknown).not.toContain('workspace.write');
    expect(unknown).not.toContain('owner.notify');
    // Egress is denied to strangers too: a DKIM-valid unknown sender must not
    // drive HTTP requests or paid searches from the owner's IP.
    expect(unknown).not.toContain('web.fetch');
    expect(registry.toolsForTask('known').map((tool) => tool.name)).toContain('web.fetch');
  });

  it('lets mission/goal progress writers run under taint without an approval', () => {
    // Regression: a mission/goal work session almost always reads untrusted
    // content before it can summarise progress. Taint no longer strips tools
    // from a privileged registry, so availability alone is not the property
    // worth pinning — acceptsUntrustedInput is. It is what keeps these two off
    // the dispatcher's taintNeedsApproval path, so the loop can record progress
    // without prompting the owner on every step instead of silently repeating
    // step one forever.
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const owner = registry.toolsForTask('owner').map((tool) => tool.name);

    expect(owner).toContain('mission.update');
    expect(owner).toContain('goals.update_progress');
    expect(registry.get('mission.update')?.tool.acceptsUntrustedInput).toBe(true);
    expect(registry.get('goals.update_progress')?.tool.acceptsUntrustedInput).toBe(true);
  });
});

describe('goals.list (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  const createdGoalIds: string[] = [];

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      const [agent] = await db.select().from(agents).limit(1);
      if (!agent) throw new Error('unseeded');
      agentId = agent.id;
      dbUp = true;
    } catch {
      console.warn('builtin goals.list test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp && createdGoalIds.length) {
      await db.delete(goals).where(inArray(goals.id, createdGoalIds));
    }
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('lists active goals first and never surfaces archived ones', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const stamp = Date.now();
    const fixtures = [
      { status: 'abandoned', title: `test-goal-abandoned-${stamp}` },
      { status: 'done', title: `test-goal-done-${stamp}` },
      { status: 'paused', title: `test-goal-paused-${stamp}` },
      { status: 'active', title: `test-goal-active-${stamp}` },
      { status: 'active', title: `test-goal-archived-${stamp}`, archived: true },
    ] as const;
    for (const fixture of fixtures) {
      const [row] = await db
        .insert(goals)
        .values({
          agentId,
          title: fixture.title,
          status: fixture.status,
          ...('archived' in fixture ? { archivedAt: new Date() } : {}),
        })
        .returning({ id: goals.id });
      createdGoalIds.push((row as NonNullable<typeof row>).id);
    }

    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const tool = registry.get('goals.list')?.tool;
    if (!tool) throw new Error('goals.list not registered');
    const toolCtx = {
      taskId: crypto.randomUUID(),
      agentId,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    } as ToolContext;
    const result = (await tool.execute({}, toolCtx)) as {
      goals: Array<{ id: string; status: string }>;
    };

    const visibleIds = new Set(createdGoalIds.slice(0, 4));
    const mine = result.goals.filter((goal) => visibleIds.has(goal.id));
    expect(mine.map((goal) => goal.status)).toEqual(['active', 'paused', 'done', 'abandoned']);
    // The archived goal appears nowhere in the list the model sees.
    expect(result.goals.some((goal) => goal.id === createdGoalIds[4])).toBe(false);
  });
});
