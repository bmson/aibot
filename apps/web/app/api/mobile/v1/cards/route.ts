import { listSavedCards } from '@assistant/application/cards';
import { getAgentIdentity, getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const agent = await getAgentIdentity();
  if (!agent.id) return mobileJson({ cards: [] });
  const cards = await listSavedCards(getDb(), agent.id);
  return mobileJson({
    cards: cards.map((card) => ({
      ...card,
      updatedAt: card.updatedAt.toISOString(),
    })),
  });
}
