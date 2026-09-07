/** Seed isolated, intentionally conflicting claims for native People evidence QA.
 * DATABASE_URL=postgres://assistant:assistant@localhost:5432/assistant_test pnpm tsx scripts/visual-qa/people-evidence.ts
 * Never targets production or invokes a model. Leave fixtures for simulator interaction.
 */
import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  contacts,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';

const databaseUrl = process.env.DATABASE_URL ?? '';
const parsed = new URL(databaseUrl);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
  throw new Error('QA requires a local _test database.');
const db = createDb(databaseUrl);
const agent = await getAgent(db);
const marker = `people-evidence-qa-${randomUUID()}`;
const people = [];
for (const name of ['Alex Rivera', 'Robin Rivera']) {
  const [person] = await db
    .insert(contacts)
    .values({ name, relationship: 'Family', trust: 'known', notes: marker })
    .returning();
  if (!person) throw new Error('Missing contact');
  const [entity] = await db
    .insert(knowledgeGraphEntities)
    .values({
      agentId: agent.id,
      label: name,
      kind: 'person',
      contactId: person.id,
      canonicalKey: `contact:${person.id}`,
    })
    .returning();
  if (!entity) throw new Error('Missing entity');
  people.push({ person, entity });
}
const alex = people[0];
const robin = people[1];
if (!alex || !robin) throw new Error('Missing people');
const claims = [];
for (const [index, predicate] of ['parent_of', 'son_of'].entries()) {
  const memoryId = randomUUID();
  const contentHash = `${marker}-${index}`;
  const content =
    index === 0
      ? 'Alex Rivera is the parent of Robin Rivera.'
      : 'Alex Rivera is the son of Robin Rivera. This QA claim is intentionally incorrect.';
  await db.insert(memories).values({
    id: memoryId,
    agentId: agent.id,
    category: 'knowledge',
    kind: 'fact',
    content,
    contentHash,
    subjectContactId: alex.person.id,
    embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
  });
  await db.insert(knowledgeGraphSources).values({
    memoryId,
    contentHash,
    status: 'ready',
    extractionVersion: GRAPH_EXTRACTION_VERSION,
  });
  const [claim] = await db
    .insert(knowledgeGraphRelations)
    .values({
      agentId: agent.id,
      subjectEntityId: alex.entity.id,
      objectEntityId: robin.entity.id,
      predicate,
      sourceMemoryId: memoryId,
      evidenceQuote: content,
      sourceFingerprint: contentHash,
      ordinal: 0,
      confidence: '0.9',
      reviewStatus: index === 0 ? 'confirmed' : 'unreviewed',
    })
    .returning({ id: knowledgeGraphRelations.id });
  claims.push(claim);
}
console.log(JSON.stringify({ marker, alex: alex.person.id, robin: robin.person.id, claims }));
await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
