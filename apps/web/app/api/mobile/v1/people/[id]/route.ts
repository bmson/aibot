import { getPersonDossier } from '@assistant/application/people';
import {
  derivePersonGroup,
  PERSON_GROUP_LABELS,
  personInitials,
} from '@assistant/application/people-presentation';
import { type PersonCardView, toPersonCardView } from '@assistant/application/people-view';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createInstallationStore,
  FirestoreProfilePeopleReadRepository,
  getFirestorePeopleDirectory,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import type { ProfileContact } from '@assistant/persistence';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

// Mirrors the validation the other mobile person routes use, so a malformed id
// is a 400 rather than a 500 from the query layer.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toFirestorePersonCard(contact: ProfileContact, factCount: number): PersonCardView {
  const group = derivePersonGroup(contact);
  return {
    id: contact.id,
    name: contact.name,
    initials: personInitials(contact.name),
    relationship: contact.relationship,
    group,
    groupLabel: group === 'other' ? '' : PERSON_GROUP_LABELS[group],
    trust: contact.trust,
    location: null,
    birthday: null,
    lastContact: null,
    howWeMet: [],
    relations: [],
    connections: [],
    events: [],
    eventsAreRecent: false,
    reminder: null,
    factCount,
  };
}

/**
 * One person's card. Editing still goes through `memory/people/<id>` — this is
 * the read the card renders from, and it is deliberately separate so the
 * existing PATCH/DELETE/merge contract keeps its shape.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
    });
    try {
      const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
      const contacts = await getFirestorePeopleDirectory(store, config.FIRESTORE_AGENT_ID);
      const contact = contacts.find((candidate) => candidate.id === id);
      if (!contact) return mobileJson({ error: 'person not found' }, { status: 404 });
      const { total } = await new FirestoreProfilePeopleReadRepository(
        store,
        config.FIRESTORE_AGENT_ID,
      ).getFacts(id, 0);
      const agents = await store.collection('agents').limit(2).get();
      if (
        agents.size !== 1 ||
        agents.docs[0]?.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
        agents.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID
      )
        throw new Error('People detail requires exactly one configured agent');
      await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
      return mobileJson(toFirestorePersonCard(contact, total));
    } finally {
      await store.db.terminate();
    }
  }
  const now = new Date();
  const dossier = await getPersonDossier(getDb(), id, { now });
  if (!dossier) return mobileJson({ error: 'person not found' }, { status: 404 });
  return mobileJson(toPersonCardView(dossier, now));
}
