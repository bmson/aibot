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
 *   pnpm tsx scripts/retire-machinery-loops.ts            # dry run, writes nothing
 *   pnpm tsx scripts/retire-machinery-loops.ts --apply    # dismiss them
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
const config = loadConfig();
const db = createDb(config.DATABASE_URL);

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
    console.log('No machinery-authored loops are open. Nothing to do.');
    return;
  }

  console.log(`${rows.length} open loop(s) came from a non-owner conversation:\n`);
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
