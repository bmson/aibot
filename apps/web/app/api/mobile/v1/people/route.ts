import { listPeopleDirectory } from '@assistant/application/people';
import { toPersonSummaryView } from '@assistant/application/people-view';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The People directory, with every label already rendered. The client sorts
 * and groups; it never formats a date or decides what a span may claim.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const now = new Date();
  const people = await listPeopleDirectory(getDb(), { now });
  return mobileJson({
    generatedAt: now.toISOString(),
    people: people.map((person) => toPersonSummaryView(person, now)),
  });
}
