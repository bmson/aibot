import {
  type GenerativeCardSpecV1,
  GenerativeCardSpecV1Schema,
} from '@assistant/core/generative-card';
import type { Db } from '@assistant/db';
import { generatedCardRevisions, generatedCards } from '@assistant/db';
import { and, desc, eq, gte, isNull, or } from 'drizzle-orm';

export interface SavedCardView {
  id: string;
  revisionId: string;
  status: 'active' | 'dismissed' | 'expired';
  spec: GenerativeCardSpecV1;
  conversationId: string | null;
  updatedAt: Date;
}

export async function listSavedCards(db: Db, agentId: string): Promise<SavedCardView[]> {
  const now = new Date();
  const rows = await db
    .select({
      id: generatedCards.id,
      revisionId: generatedCards.currentRevisionId,
      status: generatedCards.status,
      conversationId: generatedCards.conversationId,
      expiresAt: generatedCards.expiresAt,
      updatedAt: generatedCards.updatedAt,
      spec: generatedCardRevisions.spec,
    })
    .from(generatedCards)
    .innerJoin(
      generatedCardRevisions,
      eq(generatedCardRevisions.id, generatedCards.currentRevisionId),
    )
    .where(
      and(
        eq(generatedCards.agentId, agentId),
        eq(generatedCards.status, 'active'),
        isNull(generatedCards.dismissedAt),
        or(isNull(generatedCards.expiresAt), gte(generatedCards.expiresAt, now)),
      ),
    )
    .orderBy(desc(generatedCards.updatedAt));
  return rows.flatMap((row) => {
    const parsed = GenerativeCardSpecV1Schema.safeParse(row.spec);
    if (!parsed.success) return [];
    return [
      {
        id: row.id,
        revisionId: row.revisionId,
        status: row.status as SavedCardView['status'],
        spec: parsed.data,
        conversationId: row.conversationId,
        updatedAt: row.updatedAt,
      },
    ];
  });
}

export async function dismissSavedCard(db: Db, agentId: string, cardId: string): Promise<boolean> {
  const rows = await db
    .update(generatedCards)
    .set({ status: 'dismissed', dismissedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(generatedCards.id, cardId), eq(generatedCards.agentId, agentId)))
    .returning({ id: generatedCards.id });
  return rows.length > 0;
}
