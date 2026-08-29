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
  '```mermaid',
  'graph LR',
  '  A[Saved memory] -->|supports| B[Knowledge connection]',
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
await db.delete(messages).where(eq(messages.channelMessageId, `${FIXTURE_TAG}-cards`));

if (process.argv.includes('--cleanup')) {
  console.log('QA messages removed');
  process.exit(0);
}

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
  {
    conversationId,
    role: 'assistant',
    origin: 'assistant',
    text: 'Structured grounding and calendar-conflict QA fallback.',
    parts: [
      { type: 'text', text: 'Structured grounding and calendar-conflict QA fallback.' },
      {
        type: 'data-card',
        data: {
          kind: 'knowledge-graph',
          id: `${FIXTURE_TAG}-graph`,
          title: 'Source-backed connection',
          complete: true,
          nodes: [
            { id: 'owner', label: 'Owner' },
            { id: 'parade', label: 'Carnival Parade' },
          ],
          edges: [
            {
              id: 'edge-1',
              from: 'owner',
              to: 'parade',
              label: 'attended',
              evidenceQuote: 'Owner attended the Carnival Parade',
              source: 'Calendar import · May 25, 2014',
              confidence: 0.6,
              ownerConfirmed: false,
            },
          ],
        },
      },
      {
        type: 'data-card',
        data: {
          kind: 'calendar-conflicts',
          id: `${FIXTURE_TAG}-conflicts`,
          title: 'Schedule conflict',
          timeZone: 'America/Los_Angeles',
          complete: true,
          conflicts: [
            {
              id: 'conflict-1',
              overlapStart: '2026-08-29T19:00:00.000Z',
              overlapEnd: '2026-08-29T19:30:00.000Z',
              groups: [
                {
                  events: [
                    {
                      id: 'event-1',
                      title: 'Team practice',
                      start: '2026-08-29T18:30:00.000Z',
                      end: '2026-08-29T19:30:00.000Z',
                      calendar: 'Family',
                    },
                  ],
                },
                {
                  events: [
                    {
                      id: 'event-2',
                      title: 'School pickup',
                      start: '2026-08-29T19:00:00.000Z',
                      end: '2026-08-29T20:00:00.000Z',
                      calendar: 'Personal',
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    channelMessageId: `${FIXTURE_TAG}-cards`,
  },
]);

console.log(`fixture inserted into conversation ${conversationId}`);
process.exit(0);
