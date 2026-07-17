import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { contacts, memories, memoryTombstones } from './schema.js';

/** Subjects that are the assistant itself — facts about it never become contacts. */
const ASSISTANT_ALIASES = new Set(['assistant', 'ai bot', 'b bot', 'the assistant', 'bot']);

/** "Baldvin" name-prefixes "Baldvin Kristjánsson" (word boundary, either direction). */
function namePrefixMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && (longer === shorter || longer.startsWith(`${shorter} `));
}

/**
 * Entity resolution for memory attribution: "who is this fact about?"
 * 'owner' (any casing) or any name-prefix variant of the owner's name → the
 * owner contact; other names match contacts case-insensitively, treating
 * "Anna" and "Anna Jónsdóttir" as the same person (the fuller name wins and
 * is written back). New people become trust:'unknown' contacts. Subjects
 * that are the assistant itself resolve to null — the assistant is not a
 * contact. Pure data access — lives in @assistant/db so both core and tools
 * can use it without a package cycle.
 */
export async function resolveSubjectContact(
  db: Db,
  input: { subject: string; relationship?: string },
): Promise<{ contactId: string; created: boolean } | null> {
  const name = input.subject.trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  if (ASSISTANT_ALIASES.has(lower)) return null;

  const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
  if (lower === 'owner' || (owner && namePrefixMatch(lower, owner.name.toLowerCase()))) {
    if (!owner) return null;
    // adopt the fuller name ("Baldvin" → "Baldvin Kristjánsson")
    if (name.length > owner.name.length && lower !== 'owner') {
      await db
        .update(contacts)
        .set({ name, updatedAt: sql`now()` })
        .where(eq(contacts.id, owner.id));
    }
    return { contactId: owner.id, created: false };
  }

  const candidates = await db.select().from(contacts);
  const match = candidates.find(
    (c) => c.trust !== 'owner' && namePrefixMatch(lower, c.name.toLowerCase()),
  );
  if (match) {
    if (name.length > match.name.length) {
      await db
        .update(contacts)
        .set({ name, updatedAt: sql`now()` })
        .where(eq(contacts.id, match.id));
    }
    return { contactId: match.id, created: false };
  }

  const [created] = await db
    .insert(contacts)
    .values({ name, relationship: input.relationship?.trim() ?? '', trust: 'unknown' })
    .returning();
  return created ? { contactId: created.id, created: true } : null;
}

/**
 * Merge one contact into another: memories move to the target, emails/phones
 * union, the fuller relationship survives, the source row is deleted.
 */
export async function mergeContacts(
  db: Db,
  input: { sourceId: string; targetId: string },
): Promise<{ movedMemories: number }> {
  if (input.sourceId === input.targetId) throw new Error('cannot merge a contact into itself');
  const [source] = await db.select().from(contacts).where(eq(contacts.id, input.sourceId));
  const [target] = await db.select().from(contacts).where(eq(contacts.id, input.targetId));
  if (!source || !target) throw new Error('merge: contact not found');
  if (source.trust === 'owner') throw new Error('cannot merge the owner away');

  const moved = await db
    .update(memories)
    .set({ subjectContactId: target.id })
    .where(eq(memories.subjectContactId, source.id))
    .returning({ id: memories.id });

  await db
    .update(contacts)
    .set({
      emails: [...new Set([...target.emails, ...source.emails])],
      phones: [...new Set([...target.phones, ...source.phones])],
      relationship: target.relationship || source.relationship,
      notes: [target.notes, source.notes].filter(Boolean).join('\n'),
      updatedAt: sql`now()`,
    })
    .where(eq(contacts.id, target.id));
  await db.delete(contacts).where(eq(contacts.id, source.id));
  return { movedMemories: moved.length };
}

/** True when this content hash was forgotten by the owner — it must never be re-saved. */
export async function isTombstoned(db: Db, contentHash: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memoryTombstones.id })
    .from(memoryTombstones)
    .where(eq(memoryTombstones.contentHash, contentHash))
    .limit(1);
  return Boolean(row);
}

/** Record a forgotten hash. Idempotent. */
export async function addTombstone(db: Db, contentHash: string, reason = 'owner_forget') {
  await db
    .insert(memoryTombstones)
    .values({ contentHash, reason })
    .onConflictDoNothing({ target: memoryTombstones.contentHash });
}
