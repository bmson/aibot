import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { contacts, createDb, occasions } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPersonDossier, listPeopleDirectory } from '../people.js';
import { addPersonOccasion, type PersonOccasionInput, updatePersonOccasion } from './commands.js';

const db = createDb(
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant_test',
);
let contactId = '';
const input: PersonOccasionInput = {
  kind: 'birthday',
  label: '',
  month: '3',
  day: '18',
  year: '1985',
  leadDays: '14',
  notes: 'Original notes',
};

beforeAll(async () => {
  await getAgent(db);
  const [contact] = await db
    .insert(contacts)
    .values({ name: `Birthday editing ${randomUUID()}`, trust: 'known' })
    .returning();
  if (!contact) throw new Error('Could not create fixture');
  contactId = contact.id;
});
afterAll(async () => {
  if (contactId) {
    await db.delete(occasions).where(eq(occasions.contactId, contactId));
    await db.delete(contacts).where(eq(contacts.id, contactId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

describe('owner occasion editing', () => {
  it('updates the exact row, clears year and notes, and refreshes person and directory birthdays', async () => {
    expect(await addPersonOccasion(db, contactId, input)).toEqual({});
    const [original] = await db.select().from(occasions).where(eq(occasions.contactId, contactId));
    if (!original) throw new Error('Missing occasion');
    expect(
      await updatePersonOccasion(db, original.id, {
        ...input,
        month: '2',
        day: '29',
        year: '',
        notes: '',
        leadDays: '3',
      }),
    ).toEqual({});
    const rows = await db.select().from(occasions).where(eq(occasions.contactId, contactId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: original.id,
      month: 2,
      day: 29,
      year: null,
      notes: '',
      leadDays: 3,
      ownerConfirmed: true,
    });
    const dossier = await getPersonDossier(db, contactId);
    expect(dossier?.birthday).toMatchObject({ month: 2, day: 29, year: null });
    const directory = await listPeopleDirectory(db);
    expect(directory.find((person) => person.id === contactId)?.birthday).toMatchObject({
      month: 2,
      day: 29,
      year: null,
    });
  });

  it('rejects impossible dates and leaves the saved birthday intact', async () => {
    const [original] = await db.select().from(occasions).where(eq(occasions.contactId, contactId));
    if (!original) throw new Error('Missing occasion');
    for (const change of [
      { month: '2', day: '30' },
      { month: '2', day: '29', year: '2025' },
      { month: '4', day: '31' },
      { leadDays: '-1' },
    ]) {
      expect(
        (await updatePersonOccasion(db, original.id, { ...input, ...change })).error,
      ).toBeTruthy();
    }
    const [after] = await db.select().from(occasions).where(eq(occasions.id, original.id));
    expect(after).toMatchObject({ month: 2, day: 29, year: null });
  });

  it('reports a missing row instead of creating a replacement', async () => {
    expect((await updatePersonOccasion(db, randomUUID(), input)).error).toContain(
      'no longer exists',
    );
  });
});
