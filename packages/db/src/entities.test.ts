import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  deleteContact,
  mergeContacts,
  normalizeContactName,
  renameContact,
  resolveSubjectContact,
} from './entities.js';
import { contacts, memories, memoryTombstones } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let ownerId: string;
let ownerOriginalName: string;
let agentId: string;
const createdContactIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
    if (!owner) throw new Error('no owner');
    ownerId = owner.id;
    ownerOriginalName = owner.name;
    const [agentRow] = await db.execute(sql`select id from agents limit 1`);
    agentId = (agentRow as { id: string }).id;
    dbUp = true;
  } catch {
    console.warn('entities.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.update(contacts).set({ name: ownerOriginalName }).where(eq(contacts.id, ownerId));
    await db.delete(memories).where(sql`${memories.content} LIKE 'xtest-entities%'`);
    await db
      .delete(memoryTombstones)
      .where(sql`${memoryTombstones.contentHash} LIKE 'xtest-entities-%'`);
    if (createdContactIds.length) {
      await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
    }
    await db.delete(contacts).where(sql`${contacts.name} LIKE 'Xtest%'`);
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('contact names', () => {
  it('normalizes whitespace and rejects unsafe names', () => {
    expect(normalizeContactName('  Anna   Jónsdóttir  ')).toBe('Anna Jónsdóttir');
    expect(() => normalizeContactName('   ')).toThrow('required');
    expect(() => normalizeContactName(`Anna\u0000Bad`)).toThrow('control');
    expect(() => normalizeContactName('x'.repeat(121))).toThrow('120');
  });

  it('renames a non-owner person but never the owner', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Old Name', trust: 'known' })
      .returning();
    if (!person) throw new Error('failed to create test person');
    createdContactIds.push(person.id);

    await expect(
      renameContact(db, { contactId: person.id, name: '  Xtest-New   Name ' }),
    ).resolves.toEqual({ name: 'Xtest-New Name' });
    const [renamed] = await db.select().from(contacts).where(eq(contacts.id, person.id));
    expect(renamed?.name).toBe('Xtest-New Name');

    await expect(renameContact(db, { contactId: ownerId, name: 'Not the owner' })).rejects.toThrow(
      'cannot be renamed',
    );
  });

  it('deletes a person, tombstones their facts, and never deletes the owner', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [person] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Delete Person', trust: 'known' })
      .returning();
    if (!person) throw new Error('failed to create test person');
    const contentHash = 'xtest-entities-delete-contact-hash';
    const [personFact] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'person',
        content: 'xtest-entities: delete this person fact',
        contentHash,
        originTrust: 'owner',
        subjectContactId: person.id,
      })
      .returning();
    if (!personFact) throw new Error('failed to create test person fact');
    const referringHash = 'xtest-entities-delete-referring-hash';
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: 'xtest-entities: fact that previously referred to the deleted fact',
      contentHash: referringHash,
      originTrust: 'owner',
      subjectContactId: ownerId,
      supersededById: personFact.id,
    });

    await expect(deleteContact(db, person.id)).resolves.toEqual({ deletedMemories: 1 });
    const [[deletedPerson], [deletedFact], [tombstone], [referringFact]] = await Promise.all([
      db.select().from(contacts).where(eq(contacts.id, person.id)),
      db.select().from(memories).where(eq(memories.contentHash, contentHash)),
      db.select().from(memoryTombstones).where(eq(memoryTombstones.contentHash, contentHash)),
      db.select().from(memories).where(eq(memories.contentHash, referringHash)),
    ]);
    expect(deletedPerson).toBeUndefined();
    expect(deletedFact).toBeUndefined();
    expect(tombstone?.reason).toBe('owner_delete_contact');
    expect(referringFact?.supersededById).toBeNull();

    await expect(deleteContact(db, ownerId)).rejects.toThrow('cannot be deleted');
  });
});

describe('resolveSubjectContact', () => {
  it('never creates a contact for the assistant itself', async (ctx) => {
    if (!dbUp) return ctx.skip();
    expect(await resolveSubjectContact(db, { subject: 'assistant' })).toBeNull();
    expect(await resolveSubjectContact(db, { subject: 'AI Bot' })).toBeNull();
  });

  it("matches the owner's fuller name to the owner contact and adopts it", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [owner] = await db.select().from(contacts).where(eq(contacts.id, ownerId));
    const fullName = `${owner?.name} Xtestson`;

    const resolved = await resolveSubjectContact(db, { subject: fullName });
    expect(resolved?.contactId).toBe(ownerId);
    expect(resolved?.created).toBe(false);

    const [after] = await db.select().from(contacts).where(eq(contacts.id, ownerId));
    expect(after?.name).toBe(fullName); // fuller name adopted
    // and the fuller name keeps resolving to the owner
    const again = await resolveSubjectContact(db, { subject: fullName });
    expect(again?.contactId).toBe(ownerId);
  });

  it('treats "Anna" and "Anna Xtestdóttir" as the same person, fuller name wins', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await resolveSubjectContact(db, {
      subject: 'Xtest-Anna',
      relationship: 'friend',
    });
    expect(first?.created).toBe(true);
    if (first) createdContactIds.push(first.contactId);

    const fuller = await resolveSubjectContact(db, { subject: 'Xtest-Anna Jónsdóttir' });
    expect(fuller?.created).toBe(false);
    expect(fuller?.contactId).toBe(first?.contactId);

    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, first?.contactId ?? ''));
    expect(row?.name).toBe('Xtest-Anna Jónsdóttir');
    expect(row?.relationship).toBe('friend');

    // the short form still resolves to the same (now fuller-named) contact
    const short = await resolveSubjectContact(db, { subject: 'xtest-anna' });
    expect(short?.contactId).toBe(first?.contactId);
  });
});

describe('mergeContacts', () => {
  it('moves facts, unions fields, deletes the duplicate', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [dup] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Dup', relationship: 'cousin', emails: ['dup@x.is'], trust: 'unknown' })
      .returning();
    const [target] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Dup Fullname', emails: ['full@x.is'], trust: 'unknown' })
      .returning();
    createdContactIds.push((target as NonNullable<typeof target>).id);

    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: 'xtest-entities: dup fact',
      contentHash: 'xtest-entities-hash-1',
      originTrust: 'owner',
      subjectContactId: (dup as NonNullable<typeof dup>).id,
    });

    const result = await mergeContacts(db, {
      sourceId: (dup as NonNullable<typeof dup>).id,
      targetId: (target as NonNullable<typeof target>).id,
    });
    expect(result.movedMemories).toBe(1);

    const [gone] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, (dup as NonNullable<typeof dup>).id));
    expect(gone).toBeUndefined();
    const [merged] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, (target as NonNullable<typeof target>).id));
    expect(merged?.relationship).toBe('cousin');
    expect(merged?.emails.sort()).toEqual(['dup@x.is', 'full@x.is']);
    const [fact] = await db
      .select()
      .from(memories)
      .where(eq(memories.contentHash, 'xtest-entities-hash-1'));
    expect(fact?.subjectContactId).toBe((target as NonNullable<typeof target>).id);
  });

  it('refuses to merge the owner away', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [other] = await db
      .insert(contacts)
      .values({ name: 'Xtest-Other', trust: 'unknown' })
      .returning();
    createdContactIds.push((other as NonNullable<typeof other>).id);
    await expect(
      mergeContacts(db, { sourceId: ownerId, targetId: (other as NonNullable<typeof other>).id }),
    ).rejects.toThrow(/owner/);
  });
});
