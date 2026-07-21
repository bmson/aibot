import { createDb, type Db, skills, tasks, toolCalls } from '@assistant/db';
import { eq, inArray, like, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { enqueueTask } from '../workflow/machine.js';
import { runSkillReflection } from './skill-reflect.js';
import {
  deleteSkill,
  listSkills,
  recallSkills,
  renderSkillsBlock,
  saveSkill,
  setSkillDeprecated,
} from './skills.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const fakeRouter = {
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.02));
  },
  async object(_role: string, opts: { prompt?: string }) {
    const worth = (opts.prompt ?? '').includes('XTEST_SKILL_GOAL');
    return {
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      object: worth
        ? {
            worthSkill: true,
            name: 'xtest-reflected-skill',
            preconditions: 'when testing reflection',
            steps: 'do the xtest thing carefully',
            gotchas: '',
          }
        : { worthSkill: false, name: '', preconditions: '', steps: '', gotchas: '' },
    };
  },
} as unknown as ModelRouter;

describe('skill library', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const createdTaskIds: string[] = [];

  async function doneTask(instruction: string, tainted: boolean): Promise<string> {
    const { task } = await enqueueTask(db, {
      event: { source: 'internal', agentId, trust: 'assistant', payload: { instruction } },
      type: 'adhoc',
    });
    createdTaskIds.push(task.id);
    await db
      .update(tasks)
      .set({
        status: 'done',
        ...(tainted ? { state: { ...(task.state ?? {}), untrustedContext: true } } : {}),
      })
      .where(eq(tasks.id, task.id));
    for (let i = 0; i < 2; i++) {
      await db.insert(toolCalls).values({
        taskId: task.id,
        step: i,
        toolName: 'web.fetch',
        args: {},
        risk: 'autonomous',
        status: 'succeeded',
      });
    }
    return task.id;
  }

  async function cleanupSkills(): Promise<void> {
    await db
      .delete(skills)
      .where(
        or(
          like(skills.name, 'xtest%'),
          createdTaskIds.length ? inArray(skills.sourceTaskId, createdTaskIds) : undefined,
        ),
      );
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanupSkills();
    } catch {
      console.warn('skills.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) {
      await cleanupSkills();
      if (createdTaskIds.length) {
        await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
        await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
      }
    }
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('saves, recalls, refuses tainted origin, and preserves owner authorship', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const first = await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-book-flights',
      preconditions: 'booking a flight',
      steps: 'check seat maps before paying',
      originTrust: 'assistant',
    });
    expect(first.saved).toBe(true);

    // recall finds it; render produces an advice block
    const found = await recallSkills(db, fakeRouter, agentId, 'how do I book a flight?');
    expect(found.some((s) => s.name === 'xtest-book-flights')).toBe(true);
    expect(renderSkillsBlock(found)).toContain('xtest-book-flights');

    // an untrusted origin can never write a skill
    await expect(
      saveSkill(db, fakeRouter, {
        agentId,
        name: 'xtest-evil',
        steps: 'do sketchy thing',
        originTrust: 'unknown',
      }),
    ).rejects.toThrow(/owner\/assistant/);

    // owner hand-authors the same-named skill; a later assistant revision must not clobber it
    await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-book-flights',
      steps: 'ALWAYS check seat maps and prices on two sites first',
      originTrust: 'owner',
      ownerAuthored: true,
    });
    const afterOwner = await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-book-flights',
      steps: 'assistant tries to overwrite',
      originTrust: 'assistant',
    });
    expect(afterOwner.skill?.ownerAuthored).toBe(true);
    expect(afterOwner.skill?.steps).toContain('two sites'); // owner wording kept

    // deprecated skills drop out of recall
    const [row] = await db.select().from(skills).where(eq(skills.name, 'xtest-book-flights'));
    await setSkillDeprecated(db, row?.id ?? '', true);
    const afterDeprecate = await recallSkills(db, fakeRouter, agentId, 'book a flight');
    expect(afterDeprecate.some((s) => s.name === 'xtest-book-flights')).toBe(false);
    await deleteSkill(db, row?.id ?? '');
  });

  it('reflection drafts a skill from an eligible task, and a tainted task cannot', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const goodTaskId = await doneTask('XTEST_SKILL_GOAL solve the hard vendor form', false);
    const r = await runSkillReflection({ db, router: fakeRouter });
    expect(r.skillsDrafted).toBeGreaterThanOrEqual(1);
    const [drafted] = await db.select().from(skills).where(eq(skills.sourceTaskId, goodTaskId));
    expect(drafted?.name).toBe('xtest-reflected-skill');
    expect(drafted?.originTrust).toBe('assistant');

    // a tainted task with the same profitable goal produces NO skill
    const taintedTaskId = await doneTask('XTEST_SKILL_GOAL do the same but tainted', true);
    await runSkillReflection({ db, router: fakeRouter });
    const fromTainted = await db
      .select()
      .from(skills)
      .where(eq(skills.sourceTaskId, taintedTaskId));
    expect(fromTainted).toHaveLength(0);
  });

  it('listSkills returns owner-authored first', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-learned',
      steps: 'a',
      originTrust: 'assistant',
    });
    await saveSkill(db, fakeRouter, {
      agentId,
      name: 'xtest-mine',
      steps: 'b',
      originTrust: 'owner',
      ownerAuthored: true,
    });
    const list = (await listSkills(db, agentId)).filter((s) => s.name.startsWith('xtest-'));
    expect(list[0]?.ownerAuthored).toBe(true);
  });
});
