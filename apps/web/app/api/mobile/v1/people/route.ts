import { GRAPH_EXTRACTION_VERSION } from '@assistant/application/knowledge-graph';
import {
  listPeopleDirectory,
  type PersonSummary,
  personSummaryFromStoredRow,
} from '@assistant/application/people';
import { toPersonSummaryView } from '@assistant/application/people-view';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { getFirestoreMobilePeopleDirectory } from '@assistant/firestore';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The People directory, with every label already rendered. The client sorts
 * and groups; it never formats a date or decides what a span may claim.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const now = new Date();
  const config = loadConfig();
  let people: PersonSummary[];
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const rows = await getFirestoreMobilePeopleDirectory(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
      now,
      GRAPH_EXTRACTION_VERSION,
    );
    people = rows.map((row) => personSummaryFromStoredRow(row, now));
  } else {
    people = await listPeopleDirectory(getDb(), { now });
  }
  return mobileJson({
    generatedAt: now.toISOString(),
    people: people.map((person) => toPersonSummaryView(person, now)),
  });
}
