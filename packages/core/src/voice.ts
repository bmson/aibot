import { type Db, voiceProfile, writingSamples } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ModelRouter } from './model-router/router.js';

export type VoiceRegister = 'email_professional' | 'email_casual' | 'sms' | 'chat';

/** Auto-captured samples are prefixed so the cap counts only them, never uploads. */
const AUTO_SAMPLE_PREFIX = 'auto:';
const MIN_SAMPLE_CHARS = 80;
const MAX_SAMPLE_CHARS = 4000;
const MAX_AUTO_SAMPLES = 300;

/**
 * Opportunistically learn the owner's voice from their own authenticated,
 * non-forwarded messages (the owner writing TO the bot is a sample of how the
 * owner writes). Bounded, deduped, and best-effort — never fails the caller.
 *
 * CALLERS MUST pass only owner-authored, non-tainted text: a forwarded or
 * quoted message is third-party content and must never enter the private voice
 * corpus. Trivial one-liners are skipped (too short to be a useful sample).
 */
export async function captureOwnerWritingSample(
  db: Db,
  router: ModelRouter,
  input: { text: string; register: VoiceRegister; context?: string },
): Promise<boolean> {
  const text = input.text.trim();
  if (text.length < MIN_SAMPLE_CHARS || text.length > MAX_SAMPLE_CHARS) return false;
  try {
    const [duplicate] = await db
      .select({ id: writingSamples.id })
      .from(writingSamples)
      .where(eq(writingSamples.text, text))
      .limit(1);
    if (duplicate) return false;
    const [count] = await db
      .select({ n: sql<number>`count(*)` })
      .from(writingSamples)
      .where(sql`${writingSamples.context} LIKE ${`${AUTO_SAMPLE_PREFIX}%`}`);
    if (Number(count?.n ?? 0) >= MAX_AUTO_SAMPLES) return false;
    const [embedding] = await router.embed([text.slice(0, 4000)]);
    await db.insert(writingSamples).values({
      register: input.register,
      text,
      context: `${AUTO_SAMPLE_PREFIX}${input.context ?? 'email'}`,
      embedding,
    });
    return true;
  } catch (err) {
    // Sampling is a nicety; a failed embed/insert must never affect triage.
    console.error('owner voice sample capture failed', err);
    return false;
  }
}

export interface VoiceContext {
  description: string;
  dos: string[];
  donts: string[];
  signature: string;
  samples: string[];
}

const FactCheckSchema = z.object({
  intact: z
    .boolean()
    .describe('true only if every fact, name, date, number, and commitment is preserved'),
  problems: z.array(z.string()).default([]),
});

/** Load the voice profile + the nearest same-register samples to the draft. */
export async function loadVoiceContext(
  db: Db,
  router: ModelRouter,
  register: VoiceRegister,
  draft: string,
): Promise<VoiceContext> {
  const [profile] = await db.select().from(voiceProfile).where(eq(voiceProfile.id, 1));
  let samples: string[] = [];
  const [count] = await db
    .select({ n: sql<number>`count(*)` })
    .from(writingSamples)
    .where(eq(writingSamples.register, register));
  if (Number(count?.n ?? 0) > 0) {
    // Best-effort: sample retrieval must never fail the outbound message. A
    // budget-blocked or erroring embed (router.embed throws) simply means no
    // nearest-sample context — the profile text alone still guides the rewrite.
    try {
      const [embedding] = await router.embed([draft.slice(0, 2000)]);
      const rows = await db
        .select({ text: writingSamples.text })
        .from(writingSamples)
        .where(eq(writingSamples.register, register))
        .orderBy(sql`${writingSamples.embedding} <=> ${JSON.stringify(embedding)}::vector`)
        .limit(5);
      samples = rows.map((r) => r.text);
    } catch (err) {
      console.error('voice sample retrieval failed — continuing without samples', err);
    }
  }
  return {
    description: profile?.description ?? '',
    dos: (profile?.dos ?? []) as string[],
    donts: (profile?.donts ?? []) as string[],
    signature: profile?.signature ?? '',
    samples,
  };
}

export interface VoiceResult {
  text: string;
  rewritten: boolean;
  /** Set when a rewrite cannot be verified — the ORIGINAL draft is returned. */
  flagged?: string;
}

/**
 * draft → voice rewrite → fact-preservation check → (one retry) → result.
 * Fails safe: if the check can't confirm every fact survived, the original
 * draft is used and the failure is flagged for the approval card.
 */
export async function rewriteInVoice(
  router: ModelRouter,
  input: { draft: string; register: VoiceRegister; context: VoiceContext; taskId?: string },
): Promise<VoiceResult> {
  const { context, draft } = input;
  if (!context.description && context.samples.length === 0) {
    return { text: draft, rewritten: false };
  }

  const system = [
    "Rewrite the message in the owner's personal voice. Preserve EVERY fact, name, date, number, and commitment exactly.",
    'The assistant signs as itself (its own identity) — never as the owner.',
    context.description ? `Voice profile: ${context.description}` : '',
    context.dos.length ? `Do: ${context.dos.join('; ')}` : '',
    context.donts.length ? `Don't: ${context.donts.join('; ')}` : '',
    context.samples.length
      ? `Examples of the owner's writing (match tone, not content):\n${context.samples
          .map((s, i) => `--- example ${i + 1} ---\n${s}`)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const check = async (
    rewrittenText: string,
  ): Promise<
    { ok: true; verdict: z.infer<typeof FactCheckSchema> } | { ok: false; reason: string }
  > => {
    try {
      const result = await router.object<z.infer<typeof FactCheckSchema>>('classify', {
        taskId: input.taskId,
        schema: FactCheckSchema,
        system:
          'Compare ORIGINAL and REWRITE. intact=true only if every fact, name, date, number, and commitment in ORIGINAL survives in REWRITE (tone changes are fine).',
        prompt: `ORIGINAL:\n${draft}\n\nREWRITE:\n${rewrittenText}`,
      });
      return result.ok
        ? { ok: true, verdict: result.object }
        : { ok: false, reason: result.decision.reason };
    } catch {
      return { ok: false, reason: 'verifier unavailable' };
    }
  };

  const attempt = async (extra?: string) => {
    // Fail safe like check() below: a budget block returns {ok:false}, and a
    // provider error/timeout throws — either way fall back to the original draft
    // rather than failing the whole outbound task the rewrite is decorating.
    try {
      const result = await router.generate('rewrite', {
        taskId: input.taskId,
        system: extra ? `${system}\n\nPrevious attempt broke these facts — fix: ${extra}` : system,
        prompt: draft,
      });
      return result.ok ? result.text.trim() : null;
    } catch {
      return null;
    }
  };

  const first = await attempt();
  if (!first) return { text: draft, rewritten: false };
  const firstCheck = await check(first);
  if (!firstCheck.ok) {
    return {
      text: draft,
      rewritten: false,
      flagged: `voice rewrite could not be fact-checked (${firstCheck.reason}); using the original draft`,
    };
  }
  if (firstCheck.verdict.intact) return { text: first, rewritten: true };

  const second = await attempt(firstCheck.verdict.problems.join('; '));
  if (second) {
    const secondCheck = await check(second);
    if (!secondCheck.ok) {
      return {
        text: draft,
        rewritten: false,
        flagged: `voice rewrite retry could not be fact-checked (${secondCheck.reason}); using the original draft`,
      };
    }
    if (secondCheck.verdict.intact) return { text: second, rewritten: true };
  }

  return {
    text: draft,
    rewritten: false,
    flagged: `voice rewrite failed the fact-preservation check twice (${firstCheck.verdict.problems.join('; ') || 'unspecified'}); using the original draft`,
  };
}
