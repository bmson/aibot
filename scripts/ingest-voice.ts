/**
 * Ingest Baldvin's writing samples into the voice pipeline.
 *
 * Usage:
 *   1. Drop text files into seed-data/voice/ — one or many samples per file.
 *      Separate multiple samples in one file with a line containing only `---`.
 *      Tag register via filename prefix: email-*, sms-*, chat-* (default: email_casual).
 *      Add `-pro` for professional email tone (e.g. email-pro-clients.txt).
 *   2. pnpm voice:ingest            (local DB)
 *      pnpm voice:ingest --prod     (production DB)
 *
 * After ingesting ≥10 samples, a one-time premium pass distills the voice
 * profile (dos/don'ts/description), which you can edit later in /settings.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ModelRouter, registerForFilename } from '@assistant/core';
import { createDb, voiceProfile, writingSamples } from '@assistant/db';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const voiceDir = path.join(repoRoot, 'seed-data', 'voice');
const config = loadConfig();

const prod = process.argv.includes('--prod');
const dbUrl = prod ? process.env.PROD_DATABASE_URL : config.DATABASE_URL;
if (!dbUrl) {
  console.error(prod ? 'PROD_DATABASE_URL missing from .env' : 'DATABASE_URL missing');
  process.exit(1);
}
const db = createDb(dbUrl);
const router = new ModelRouter(db, config.OPENROUTER_API_KEY);

let files: string[] = [];
try {
  files = readdirSync(voiceDir).filter(
    (f) => (f.endsWith('.txt') || f.endsWith('.md')) && !/^readme/i.test(f),
  );
} catch {
  console.error(`no ${voiceDir} directory — create it and drop writing samples in`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`no .txt/.md files in ${voiceDir}`);
  process.exit(1);
}

let inserted = 0;
let skipped = 0;
for (const file of files) {
  const register = registerForFilename(file);
  const raw = readFileSync(path.join(voiceDir, file), 'utf8');
  const samples = raw
    .split(/\n---+\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 8000);

  for (const text of samples) {
    const existing = await db
      .select({ n: count() })
      .from(writingSamples)
      .where(eq(writingSamples.text, text));
    if (Number(existing[0]?.n ?? 0) > 0) {
      skipped += 1;
      continue;
    }
    const [embedding] = await router.embed([text.slice(0, 4000)]);
    await db.insert(writingSamples).values({ register, text, context: file, embedding });
    inserted += 1;
  }
}
console.log(`ingested ${inserted} samples (${skipped} duplicates skipped)`);

// ── distill the voice profile once there's enough material ──────────────────
const [total] = await db.select({ n: count() }).from(writingSamples);
if (Number(total?.n ?? 0) >= 10) {
  const all = await db.select().from(writingSamples).limit(40);
  const ProfileSchema = z.object({
    description: z.string().max(600),
    dos: z.array(z.string()).max(10),
    donts: z.array(z.string()).max(10),
  });
  const result = await router.object<z.infer<typeof ProfileSchema>>('reason', {
    schema: ProfileSchema,
    system:
      "Analyze these writing samples and produce a voice profile another writer could imitate: a 2-3 sentence description of the voice, concrete do's, and concrete don'ts. Focus on tone, sentence length, punctuation habits, greetings/sign-offs, formality.",
    prompt: all.map((s, i) => `--- sample ${i + 1} (${s.register}) ---\n${s.text}`).join('\n\n'),
  });
  if (result.ok) {
    await db
      .update(voiceProfile)
      .set({
        description: result.object.description,
        dos: result.object.dos,
        donts: result.object.donts,
      })
      .where(eq(voiceProfile.id, 1));
    console.log(`voice profile distilled: "${result.object.description.slice(0, 100)}..."`);
  } else {
    console.warn('profile distillation blocked by budget — rerun later');
  }
} else {
  console.log(`(${total?.n ?? 0} samples total — profile distillation kicks in at 10+)`);
}
process.exit(0);
