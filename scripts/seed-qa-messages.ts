/**
 * Deterministic visual-QA fixture: injects a markdown-rich assistant reply and
 * a user message into the primary conversation so rendering can be eyeballed
 * without spending model credit. Idempotent — deletes its own fixture first.
 *
 *   DATABASE_URL=... pnpm tsx scripts/seed-qa-messages.ts
 */
import { loadConfig } from '@assistant/config';
import { conversations, createDb, messages } from '@assistant/db';
import { eq } from 'drizzle-orm';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const FIXTURE_TAG = 'qa-markdown-fixture';

const markdown = [
  '## Trip plan',
  '',
  'Here is the breakdown for **Lisbon** in October:',
  '',
  '- Flights from KEF, direct',
  '  - Depart Oct 12, return Oct 19',
  '  - Around $420 with one checked bag',
  '- Stay near *Alfama*, not Bairro Alto',
  '- Day trip to Sintra if the weather holds',
  '',
  'Ordered priorities:',
  '',
  '1. Book flights this week — prices move on Fridays',
  '2. Reserve the apartment after flights are confirmed',
  '3. Check passport validity (> 6 months)',
  '',
  '- [x] Decide the dates',
  '- [ ] Book the flights',
  '- [ ] Tell the landlord',
  '',
  '> The last two Octobers were warm enough for the beach until mid-month.',
  '',
  '```ts',
  'const budget = { flights: 420, stay: 680, food: 350 };',
  'const total = Object.values(budget).reduce((a, b) => a + b, 0);',
  'console.log(`about $${total}`);',
  '```',
  '',
  '| Item | Estimate | Booked |',
  '| --- | --- | --- |',
  '| Flights | $420 | no |',
  '| Apartment (7 nights) | $680 | no |',
  '| Food & transit | $350 | — |',
  '',
  'Inline `code`, **bold**, *italic*, ~~struck~~, and a [link](https://example.com).',
].join('\n');

const primary = await db
  .select({ id: conversations.id })
  .from(conversations)
  .where(eq(conversations.isPrimary, true))
  .limit(1);
if (!primary[0]) throw new Error('no primary conversation — run pnpm seed first');
const conversationId = primary[0].id;

await db.delete(messages).where(eq(messages.channelMessageId, FIXTURE_TAG));
await db.delete(messages).where(eq(messages.channelMessageId, `${FIXTURE_TAG}-user`));

await db.insert(messages).values([
  {
    conversationId,
    role: 'user',
    origin: 'owner',
    text: 'Can you put together the Lisbon trip plan?',
    parts: [{ type: 'text', text: 'Can you put together the Lisbon trip plan?' }],
    channelMessageId: `${FIXTURE_TAG}-user`,
  },
  {
    conversationId,
    role: 'assistant',
    origin: 'assistant',
    text: markdown,
    parts: [{ type: 'text', text: markdown }],
    channelMessageId: FIXTURE_TAG,
  },
]);

console.log(`fixture inserted into conversation ${conversationId}`);
process.exit(0);
