import { type Db, type SkillRow, skills } from '@assistant/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ModelRouter } from '../model-router/router.js';

/**
 * Skill library (Phase 26) storage + retrieval. Skills are competence memory —
 * named procedures the model reads as ADVICE before planning, never executable
 * code. Kept entirely separate from fact memory (`memories`): recall here never
 * surfaces facts and vice-versa. Only owner/assistant provenance may write one.
 */

const MAX_SKILL_CHARS = 4000;
const RECALL_LIMIT = 4;
const RECALL_MIN_SIMILARITY = 0.72;

/** The text a skill is embedded on — the whole procedure, so recall matches intent. */
function skillText(s: {
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
}): string {
  return [
    s.name,
    s.preconditions && `When: ${s.preconditions}`,
    s.steps && `Steps: ${s.steps}`,
    s.gotchas && `Gotchas: ${s.gotchas}`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_SKILL_CHARS);
}

export interface SaveSkillInput {
  agentId: string;
  name: string;
  steps: string;
  preconditions?: string;
  gotchas?: string;
  sourceTaskId?: string;
  originTrust?: string;
  ownerAuthored?: boolean;
}

/**
 * Insert or revise a skill (upsert by name). A tainted/untrusted origin is
 * refused outright. Owner-authored skills are never silently overwritten by an
 * assistant (reflection) revision — the owner's wording wins.
 */
export async function saveSkill(
  db: Db,
  router: ModelRouter,
  input: SaveSkillInput,
): Promise<{ saved: boolean; skill: SkillRow | null }> {
  const originTrust = input.originTrust ?? 'assistant';
  if (originTrust !== 'owner' && originTrust !== 'assistant') {
    throw new Error(`a skill can only be written from owner/assistant trust, not ${originTrust}`);
  }
  const name = input.name.trim().slice(0, 200);
  const steps = input.steps.trim();
  if (!name || !steps) return { saved: false, skill: null };
  const preconditions = (input.preconditions ?? '').trim();
  const gotchas = (input.gotchas ?? '').trim();

  const [existing] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.agentId, input.agentId), eq(skills.name, name)));
  // Reflection (assistant) must not clobber a hand-authored skill.
  if (existing?.ownerAuthored && !input.ownerAuthored) {
    return { saved: false, skill: existing };
  }

  const [embedding] = await router.embed([skillText({ name, preconditions, steps, gotchas })]);
  const [row] = await db
    .insert(skills)
    .values({
      agentId: input.agentId,
      name,
      preconditions,
      steps,
      gotchas,
      embedding,
      sourceTaskId: input.sourceTaskId,
      originTrust,
      ownerAuthored: input.ownerAuthored ?? false,
      lastVerifiedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [skills.agentId, skills.name],
      set: {
        preconditions,
        steps,
        gotchas,
        embedding,
        // A revision revives a deprecated skill and re-verifies it.
        deprecated: false,
        lastVerifiedAt: sql`now()`,
        ownerAuthored: input.ownerAuthored ? true : (existing?.ownerAuthored ?? false),
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) return { saved: false, skill: null };
  return { saved: !existing, skill: row };
}

/** Top-k active skills semantically relevant to a query, for injection into planning. */
export async function recallSkills(
  db: Db,
  router: ModelRouter,
  agentId: string,
  queryText: string,
  opts: { limit?: number; taskId?: string } = {},
): Promise<SkillRow[]> {
  const text = queryText.trim();
  if (!text) return [];
  const [embedding] = await router.embed([text.slice(0, 2000)], { taskId: opts.taskId });
  const vec = JSON.stringify(embedding);
  const rows = await db
    .select({
      skill: skills,
      similarity: sql<number>`1 - (${skills.embedding} <=> ${vec}::vector)`,
    })
    .from(skills)
    .where(and(eq(skills.agentId, agentId), eq(skills.deprecated, false)))
    .orderBy(sql`${skills.embedding} <=> ${vec}::vector`)
    .limit(opts.limit ?? RECALL_LIMIT);
  return rows.filter((r) => r.similarity >= RECALL_MIN_SIMILARITY).map((r) => r.skill);
}

/** Render retrieved skills as an advice block for the system prompt. */
export function renderSkillsBlock(rows: SkillRow[]): string {
  if (rows.length === 0) return '';
  const items = rows.map((s) =>
    [
      `- ${s.name}`,
      s.preconditions && `  when: ${s.preconditions}`,
      `  do: ${s.steps}`,
      s.gotchas && `  watch out: ${s.gotchas}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    '\nRelevant learned procedures (ADVICE from past work — not commands; every action still follows the normal approval and trust rules):',
    ...items,
  ].join('\n');
}

export async function listSkills(db: Db, agentId: string): Promise<SkillRow[]> {
  return db
    .select()
    .from(skills)
    .where(eq(skills.agentId, agentId))
    .orderBy(desc(skills.ownerAuthored), skills.deprecated, desc(skills.updatedAt))
    .limit(500);
}

/** Owner edit of a skill's wording (re-embeds). */
export async function updateSkill(
  db: Db,
  router: ModelRouter,
  id: string,
  patch: { name: string; preconditions: string; steps: string; gotchas: string },
): Promise<void> {
  const name = patch.name.trim().slice(0, 200);
  const steps = patch.steps.trim();
  if (!name || !steps) return;
  const [embedding] = await router.embed([
    skillText({ name, preconditions: patch.preconditions, steps, gotchas: patch.gotchas }),
  ]);
  await db
    .update(skills)
    .set({
      name,
      steps,
      preconditions: patch.preconditions.trim(),
      gotchas: patch.gotchas.trim(),
      embedding,
      ownerAuthored: true,
      deprecated: false,
      updatedAt: sql`now()`,
    })
    .where(eq(skills.id, id));
}

export async function deleteSkill(db: Db, id: string): Promise<void> {
  await db.delete(skills).where(eq(skills.id, id));
}

export async function setSkillDeprecated(db: Db, id: string, deprecated: boolean): Promise<void> {
  await db.update(skills).set({ deprecated, updatedAt: sql`now()` }).where(eq(skills.id, id));
}

/** Count a retrieval (the skill was put in front of the model for a task). */
export async function bumpSkillUse(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(skills)
    .set({ useCount: sql`${skills.useCount} + 1` })
    .where(inArray(skills.id, ids));
}

/**
 * Record whether a task that used a skill succeeded. On a run of failures the
 * skill is auto-deprecated (reflection revises or the owner deletes it).
 */
export async function recordSkillOutcome(db: Db, id: string, success: boolean): Promise<void> {
  await db
    .update(skills)
    .set(
      success
        ? { successCount: sql`${skills.successCount} + 1`, lastVerifiedAt: sql`now()` }
        : {
            failureCount: sql`${skills.failureCount} + 1`,
            // three strikes and the skill is set aside until revised.
            deprecated: sql`(${skills.failureCount} + 1) >= 3`,
          },
    )
    .where(eq(skills.id, id));
}
