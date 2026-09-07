/** Isolated fixtures and browser interaction regression checks. Start local web on 3107 first.
 * DATABASE_URL=postgres://assistant:assistant@localhost:5432/assistant_test pnpm tsx scripts/visual-qa/knowledge-graph.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  contacts,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  occasions,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';

const databaseUrl = process.env.DATABASE_URL ?? '';
const parsed = new URL(databaseUrl);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
  throw new Error('QA requires a local _test database.');
const db = createDb(databaseUrl);
const agent = await getAgent(db);
const marker = randomUUID();
const fixture = [
  ['Alex Rivera', 'person'],
  ['Robin Rivera', 'person'],
  ['Northstar Robotics', 'organization'],
  ['San Francisco', 'place'],
  ['School fundraiser', 'project'],
  ['Maya Chen', 'person'],
];
const nodes = fixture.map(([label, kind]) => ({
  id: randomUUID(),
  agentId: agent.id,
  label: label as string,
  kind: kind as string,
  canonicalKey: `${kind}:graph-qa-${marker}-${label}`,
}));
const people = await db
  .insert(contacts)
  .values([
    { name: 'Alex Rivera', trust: 'known', relationship: 'Friend' },
    { name: 'Robin Rivera', trust: 'known', relationship: 'Friend' },
  ])
  .returning();
const alexContact = people[0];
const robinContact = people[1];
if (!alexContact || !robinContact) throw new Error('Missing people');
await db.insert(knowledgeGraphEntities).values(
  nodes.map((node, i) => ({
    ...node,
    contactId: i === 0 ? alexContact.id : i === 1 ? robinContact.id : null,
    canonicalKey:
      i === 0
        ? `contact:${alexContact.id}`
        : i === 1
          ? `contact:${robinContact.id}`
          : node.canonicalKey,
  })),
);
await db.insert(occasions).values({
  agentId: agent.id,
  contactId: alexContact.id,
  kind: 'birthday',
  month: 3,
  day: 18,
  year: 1985,
  leadDays: 14,
  notes: 'Gift ideas',
  ownerConfirmed: true,
});
const alex = nodes[0];
const robin = nodes[1];
if (!alex || !robin) throw new Error('Missing fixture');
const facts: Array<[number, string, number, string, 'confirmed' | 'unreviewed']> = [
  [0, 'parent_of', 1, 'Alex Rivera is the parent of Robin Rivera.', 'confirmed'],
  [0, 'parent_of', 1, 'Family notes: Alex Rivera is the parent of Robin Rivera.', 'unreviewed'],
  [0, 'works_at', 2, 'Alex Rivera works at Northstar Robotics.', 'confirmed'],
  [0, 'lives_in', 3, 'Alex Rivera lives in San Francisco.', 'confirmed'],
  [0, 'organizes', 4, 'Alex Rivera organizes the School fundraiser.', 'unreviewed'],
  [5, 'works_at', 2, 'Maya Chen works at Northstar Robotics.', 'unreviewed'],
  [5, 'organizes', 4, 'Maya Chen organizes the School fundraiser.', 'confirmed'],
];
for (const [index, [from, predicate, to, content, reviewStatus]] of facts.entries()) {
  const subject = nodes[from];
  const object = nodes[to];
  if (!subject || !object) throw new Error('Missing endpoint');
  const memoryId = randomUUID();
  const contentHash = randomUUID();
  await db.insert(memories).values({
    id: memoryId,
    agentId: agent.id,
    category: 'knowledge',
    kind: 'fact',
    content,
    contentHash,
    embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
  });
  await db.insert(knowledgeGraphSources).values({
    memoryId,
    contentHash,
    status: 'ready',
    extractionVersion: GRAPH_EXTRACTION_VERSION,
  });
  await db.insert(knowledgeGraphRelations).values({
    agentId: agent.id,
    subjectEntityId: subject.id,
    objectEntityId: object.id,
    predicate,
    sourceMemoryId: memoryId,
    evidenceQuote: content,
    sourceFingerprint: `${marker}-${index}`,
    ordinal: 0,
    confidence: '0.9',
    reviewStatus,
  });
}

mkdirSync('/tmp/assistant-people-qa', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const personURL = `http://127.0.0.1:3107/people/${alexContact.id}`;
try {
  await page.goto(personURL);
  const dates = page.locator('#important-dates');
  await dates.getByRole('button', { name: 'Edit birthday', exact: true }).click();
  await dates.getByLabel('Month', { exact: true }).fill('2');
  await dates.getByLabel('Day', { exact: true }).fill('29');
  await dates.getByLabel('Year (optional)', { exact: true }).fill('');
  await dates.getByLabel('Notes / gift ideas (optional)', { exact: true }).fill('');
  assert.equal(await dates.getByLabel('Remind (days before)').inputValue(), '14');
  await dates.getByRole('button', { name: 'Save changes', exact: true }).click();
  await dates
    .getByRole('button', { name: 'Save changes', exact: true })
    .waitFor({ state: 'detached' });
  await dates.getByText('Feb 29', { exact: true }).waitFor();
  await page.reload();
  assert.match(await dates.innerText(), /Feb 29/);
  const saved = await db.select().from(occasions).where(eq(occasions.contactId, alexContact.id));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.year, null);
  assert.equal(saved[0]?.notes, '');
  assert.equal(saved[0]?.leadDays, 14);
  await dates.getByRole('button', { name: 'Edit birthday', exact: true }).click();
  await dates.getByLabel('Day', { exact: true }).fill('30');
  await dates.getByRole('button', { name: 'Save changes', exact: true }).click();
  await dates
    .getByRole('alert')
    .getByText(/does not exist/)
    .waitFor();
  await dates.getByRole('button', { name: 'Cancel', exact: true }).click();

  const tree = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Explore connections', exact: true }) });
  await tree.getByRole('button', { name: 'Expand Northstar Robotics', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Maya Chen', exact: true }).click();
  await tree.getByRole('button', { name: 'Return to Northstar Robotics', exact: true }).waitFor();
  await tree.getByRole('button', { name: 'Maya Chen', exact: true }).click();
  await tree
    .getByRole('navigation', { name: 'Connection trail' })
    .getByRole('button', { name: 'Maya Chen', exact: true })
    .waitFor();
  await tree
    .getByRole('navigation', { name: 'Connection trail' })
    .getByRole('button', { name: 'Alex Rivera', exact: true })
    .click();
  await tree.getByText('Manage connection · 2 sources', { exact: true }).click();
  const managed = tree.locator('details[open]');
  await managed.getByRole('button', { name: 'View source 1', exact: true }).click();
  await managed.locator('blockquote').waitFor();
  await tree.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-people-qa/tree-desktop.png' });
  await managed.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await managed.getByRole('button', { name: 'Cancel', exact: true }).click();
  await managed.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await managed.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Robin Rivera', exact: true }).waitFor();
  await tree
    .getByText('Manage connection · 2 sources', { exact: true })
    .waitFor({ state: 'detached' });
  const relations = await db
    .select()
    .from(knowledgeGraphRelations)
    .where(eq(knowledgeGraphRelations.subjectEntityId, alex.id));
  assert.equal(
    relations.filter((row) => row.predicate === 'parent_of' && row.reviewStatus === 'rejected')
      .length,
    1,
  );
  assert.equal(
    relations.filter((row) => row.predicate === 'parent_of' && row.reviewStatus !== 'rejected')
      .length,
    1,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await tree.getByRole('button', { name: 'Expand Northstar Robotics', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Maya Chen', exact: true }).click();
  await tree.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-people-qa/tree-phone.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.reload();
  await tree.getByRole('button', { name: 'Expand Northstar Robotics', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Maya Chen', exact: true }).click();
  await tree.scrollIntoViewIfNeeded();
  assert.equal(
    await page
      .locator('html')
      .getAttribute('class')
      .then((value) => value?.includes('dark')),
    true,
  );
  await page.screenshot({ path: '/tmp/assistant-people-qa/tree-phone-dark.png' });
  await page.goto(`http://127.0.0.1:3107/profile/knowledge?view=map&entity=${alex.id}`);
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Robin Rivera', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, personURL, screenshots: '/tmp/assistant-people-qa' }));
} finally {
  await browser.close();
}
process.exit(0);
