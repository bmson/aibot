import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { contacts, memoryTombstones } from './schema.js';

/**
 * Entity resolution for memory attribution: "who is this fact about?"
 * 'owner' (any casing) → the owner contact row; a name → case-insensitive
 * match against contacts, auto-creating a trust:'unknown' contact when new.
 * Pure data access — lives in @assistant/db so both core and tools can use it
 * without a package cycle.
 */
export async function resolveSubjectContact(
  db: Db,
  input: { subject: string; relationship?: string },
): Promise<{ contactId: string; created: boolean } | null> {
  const name = input.subject.trim();
  if (!name) return null;

  if (name.toLowerCase() === 'owner') {
    const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
    return owner ? { contactId: owner.id, created: false } : null;
  }

  const [match] = await db
    .select()
    .from(contacts)
    .where(sql`lower(${contacts.name}) = ${name.toLowerCase()}`)
    .limit(1);
  if (match) return { contactId: match.id, created: false };

  const [created] = await db
    .insert(contacts)
    .values({ name, relationship: input.relationship?.trim() ?? '', trust: 'unknown' })
    .returning();
  return created ? { contactId: created.id, created: true } : null;
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
