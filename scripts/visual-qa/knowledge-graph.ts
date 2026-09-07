/** Isolated fixtures and browser interaction regression checks. Start local web on 3107 first.
 * DATABASE_URL=postgres://assistant:assistant@localhost:5432/assistant_test pnpm tsx scripts/visual-qa/knowledge-graph.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
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
await db.insert(knowledgeGraphEntities).values(nodes);
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

mkdirSync('/tmp/assistant-graph-qa', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const url = `http://127.0.0.1:3107/profile/knowledge?view=map&entity=${alex.id}`;
try {
  await page.goto(url);
  const inspector = page.getByRole('complementary', { name: 'Selected knowledge item' });
  await inspector.getByRole('heading', { name: 'Alex Rivera', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'How your knowledge connects' }).scrollIntoViewIfNeeded();
  await inspector.getByText('Supporting evidence (2)', { exact: true }).click();
  await page.screenshot({ path: '/tmp/assistant-graph-qa/web-desktop.png' });
  await inspector.getByRole('button', { name: 'Explore Robin Rivera', exact: true }).click();
  await inspector.getByRole('heading', { name: 'Robin Rivera', exact: true }).waitFor();
  assert.match(await inspector.innerText(), /Alex Rivera is Robin Rivera.s parent/);
  assert.equal(
    await inspector.getByRole('link', { name: 'Review or edit Robin Rivera' }).getAttribute('href'),
    `/profile/knowledge?view=map&entity=${robin.id}#knowledge-item`,
  );
  await page.getByLabel('Only selected item and its connections').check();
  const svg = page.getByRole('img', { name: /connected knowledge items across/ });
  const box = await svg.boundingBox();
  if (!box) throw new Error('No map bounds');
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60, { steps: 5 });
  await page.mouse.up();
  const transform = await svg.locator(':scope > g').getAttribute('transform');
  const shift = Number(transform?.match(/translate\(([^ ]+)/)?.[1]);
  assert.ok(Math.abs(shift - (80 * 1000) / box.width) < 2, `Incorrect pan: ${transform}`);
  await inspector.getByRole('heading', { name: 'Robin Rivera', exact: true }).waitFor();
  await inspector.getByRole('link', { name: 'Review or edit Robin Rivera' }).click();
  await page.waitForURL(`**entity=${robin.id}#knowledge-item`);
  await page.getByRole('heading', { name: 'Connections around Robin Rivera' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await inspector.getByRole('heading', { name: 'Alex Rivera', exact: true }).waitFor();
  await inspector.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-graph-qa/web-phone.png' });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Horizontal overflow',
  );
  await inspector.getByRole('button', { name: 'Explore Robin Rivera', exact: true }).click();
  await inspector.getByRole('heading', { name: 'Robin Rivera', exact: true }).waitFor();
  await inspector.getByText('Supporting evidence (2)', { exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await inspector.getByRole('heading', { name: 'Alex Rivera', exact: true }).waitFor();
  await inspector.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-graph-qa/web-phone-dark.png' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      alexId: alex.id,
      robinId: robin.id,
      screenshots: '/tmp/assistant-graph-qa',
    }),
  );
} finally {
  await browser.close();
}
process.exit(0);
