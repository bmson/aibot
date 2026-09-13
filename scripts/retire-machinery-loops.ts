/**
 * Retire open loops that were extracted from the assistant's own threads.
 *
 * Until `conversation?.trust !== 'owner'` landed in `extractCommitments`, the
 * nightly pass also read machinery conversations — scheduled runs, the
 * Notifications thread, document processing, all of which carry
 * trust 'assistant'. A schedule named `daily-briefing` becomes a task title
 * there, so the extractor wrote back loops like "Complete daily-briefing":
 * work the scheduler already carries, addressed to an owner who never opened
 * it and cannot meaningfully close it.
 *
 * Extraction cannot produce these any more. This clears the ones already on
 * the desk, selecting them the same way the fix does — by the trust of the
 * conversation they came from — rather than by guessing at titles.
 *
 *   pnpm tsx scripts/retire-machinery-loops.ts --prod            # dry run
 *   pnpm tsx scripts/retire-machinery-loops.ts --prod --apply    # dismiss them
 *
 * `--prod` reads PROD_DATABASE_URL, the same way verify-browse and
 * configure-models do; without it the script talks to the local development
 * database, which on most machines does not exist. The loops this clears were
 * written by a deployed assistant, so --prod is almost always what you want.
 *
 * `dismissed` rather than `stale`: stale means a loop aged out, and these
 * never had a lifetime to run down. The rows stay for the record — nothing is
 * deleted — and `listOpenCommitments` stops returning them, so they leave both
 * the memory desk and the chat recall context.
 */
import { loadConfig } from '@assistant/config';
import { commitments, conversations, createDb } from '@assistant/db';
import { and, eq, inArray, ne } from 'drizzle-orm';

const apply = process.argv.includes('--apply');
const prod = process.argv.includes('--prod');
const config = loadConfig();
const dbUrl = prod ? config.PROD_DATABASE_URL : config.DATABASE_URL;
if (!dbUrl) {
  console.error(prod ? 'PROD_DATABASE_URL missing from .env' : 'DATABASE_URL missing');
  process.exit(1);
}
const db = createDb(dbUrl);

/** Host and database name only — a connection string carries a password. */
function describe(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}/${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return 'the configured database';
  }
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: commitments.id,
      kind: commitments.kind,
      title: commitments.title,
      status: commitments.status,
      trust: conversations.trust,
      threadTitle: conversations.title,
      updatedAt: commitments.updatedAt,
    })
    .from(commitments)
    .innerJoin(conversations, eq(conversations.id, commitments.conversationId))
    .where(and(inArray(commitments.status, ['open', 'snoozed']), ne(conversations.trust, 'owner')))
    .orderBy(commitments.updatedAt);

  if (rows.length === 0) {
    console.log(`No machinery-authored loops are open in ${describe(dbUrl)}. Nothing to do.`);
    return;
  }

  console.log(
    `${rows.length} open loop(s) in ${describe(dbUrl)} came from a non-owner conversation:\n`,
  );
  for (const row of rows) {
    const when = row.updatedAt.toISOString().slice(0, 10);
    console.log(`  [${row.kind}] ${row.title}`);
    console.log(`      from ${row.trust}-trust thread "${row.threadTitle}", last touched ${when}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing was written. Re-run with --apply to dismiss these.');
    return;
  }

  const dismissed = await db
    .update(commitments)
    .set({
      status: 'dismissed',
      resolvedAt: new Date(),
      resolution: 'Extracted from an assistant-trust thread before that was fixed.',
      snoozedUntil: null,
      updatedAt: new Date(),
    })
    .where(
      inArray(
        commitments.id,
        rows.map((row) => row.id),
      ),
    )
    .returning({ id: commitments.id });

  console.log(`\nDismissed ${dismissed.length} loop(s). The rows are kept for the record.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
  });
