/** Local-only pack fixture + browser interaction QA. Never point this at production.
 * DATABASE_URL=postgres://assistant:assistant@localhost:5432/assistant_test pnpm tsx scripts/visual-qa/situation-packs.ts
 * Start the web server on 127.0.0.1:3107 with AUTH_DEV_BYPASS=true first.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getAgent } from '@assistant/core/chat';
import { commandSituationPack, getSituationPack } from '@assistant/core/situations';
import {
  commitments,
  conversations,
  createDb,
  generatedCardRevisions,
  generatedCards,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';

const databaseUrl = process.env.DATABASE_URL ?? '';
const parsed = new URL(databaseUrl);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
  throw new Error('QA requires a local _test database.');
const db = createDb(databaseUrl);
const agent = await getAgent(db);
const cardId = randomUUID();
const revisionId = randomUUID();
const loopId = randomUUID();
const conversationId = randomUUID();
await db.insert(conversations).values({
  id: conversationId,
  agentId: agent.id,
  channel: 'chat',
  title: 'Situation pack QA fixture',
  trust: 'owner',
});
await db.insert(commitments).values({
  id: loopId,
  agentId: agent.id,
  conversationId,
  kind: 'waiting_on',
  title: 'Hotel confirms late arrival',
  details: 'Waiting for a reply from the front desk.',
  contentHash: randomUUID(),
});
await db.insert(generatedCards).values({
  id: cardId,
  agentId: agent.id,
  sourceLabel: 'Synthetic QA fixture',
  sourceFingerprint: randomUUID(),
  currentRevisionId: revisionId,
});
await db.insert(generatedCardRevisions).values({
  id: revisionId,
  cardId,
  spec: {
    version: 1,
    title: 'Harbor Hotel',
    accessibilityLabel: 'Synthetic hotel reservation',
    sourceLabel: 'Synthetic QA fixture',
    facts: [
      { id: 'name', value: 'Harbor Hotel', source: 'QA fixture' },
      { id: 'arrival', label: 'Arrival', value: 'Saturday, after the match', source: 'QA fixture' },
    ],
    blocks: [
      { type: 'hero', titleFact: 'name' },
      { type: 'facts', factIds: ['arrival'] },
    ],
  },
});
const created = await commandSituationPack(db, agent.id, {
  action: 'create',
  title: 'Soccer weekend · QA',
  creationKey: randomUUID(),
});
if (!created.ok) throw new Error(created.error);
const packId = created.packId;
for (const item of [
  {
    id: 'hotel',
    title: 'Hotel for the weekend',
    details: 'Keep the reservation and arrival plan together.',
    source: { kind: 'card', id: cardId },
  },
  {
    id: 'reply',
    title: 'Late-arrival confirmation',
    lane: 'waiting_on',
    source: { kind: 'commitment', id: loopId },
  },
  {
    id: 'route',
    title: 'Plan the drive after the match',
    details: 'Recheck the destination if the hotel changes.',
    dependsOn: ['hotel'],
  },
  {
    id: 'arrival',
    title: 'Send the arrival time',
    details: 'Only after the hotel confirms.',
    lane: 'i_owe',
    dependsOn: ['reply', 'route'],
  },
]) {
  const pack = await getSituationPack(db, agent.id, packId);
  const result = await commandSituationPack(db, agent.id, {
    action: 'item',
    packId,
    version: pack?.version,
    item,
  });
  if (!result.ok) throw new Error(result.error);
}
const pack = await getSituationPack(db, agent.id, packId);
await commandSituationPack(
  db,
  agent.id,
  {
    action: 'decision',
    packId,
    version: pack?.version,
    decision: {
      id: 'food',
      option: 'A late sit-down dinner',
      outcome: 'rejected',
      reason: 'Too late for the kids after the match.',
      scope: 'situation',
    },
  },
  { ownerConfirmed: true },
);
// Source mutation, not a pack edit: exercises change-aware projection.
await db
  .update(commitments)
  .set({
    status: 'resolved',
    resolution: 'QA: the owner confirmed receipt of the hotel reply.',
    updatedAt: new Date(),
  })
  .where(eq(commitments.id, loopId));
await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();

const out = '/tmp/assistant-packs-qa';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  reducedMotion: 'reduce',
});
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:3107/packs', { waitUntil: 'networkidle' });
await page.getByLabel('Choose pack').selectOption(packId);
await page.screenshot({ path: `${out}/web-phone-overview.png`, fullPage: true });
const changedRow = page
  .locator('article')
  .getByRole('heading', { name: 'Hotel for the weekend', exact: true });
await changedRow
  .locator('..')
  .locator('..')
  .getByRole('button', { name: 'Review / change' })
  .click();
await page.getByLabel('Title', { exact: true }).fill('Revised hotel plan');
await page.getByRole('button', { name: 'Preview change', exact: true }).click();
await page.getByRole('heading', { name: 'Rehearsal · not applied' }).waitFor();
// The persisted row still has its old title until the explicit Apply button.
if (await page.getByRole('heading', { name: 'Revised hotel plan', exact: true }).count())
  throw new Error('Preview mutated the plan.');
await page.screenshot({ path: `${out}/web-phone-preview.png`, fullPage: true });
await page.getByRole('button', { name: 'Apply to pack', exact: true }).click();
await page.getByRole('heading', { name: 'Revised hotel plan', exact: true }).waitFor();
const notice = await page.getByRole('status').filter({ hasText: 'Pack updated.' }).textContent();
if (!notice?.includes('nothing outside this pack changed'))
  throw new Error('Missing apply scope feedback');
await page.setViewportSize({ width: 1280, height: 900 });
await page.screenshot({ path: `${out}/web-desktop.png`, fullPage: true });
await page.emulateMedia({ colorScheme: 'dark' });
await page.reload({ waitUntil: 'networkidle' });
await page.getByLabel('Choose pack').selectOption(packId);
if (!(await page.locator('html').getAttribute('class'))?.includes('dark'))
  throw new Error('Dark theme was not applied.');
await page.screenshot({ path: `${out}/web-dark.png`, fullPage: true });
if (errors.length) throw new Error(errors.join('\n'));
await browser.close();
console.log(`Pack ${packId}: browser preview/apply passed. Screenshots: ${out}`);
