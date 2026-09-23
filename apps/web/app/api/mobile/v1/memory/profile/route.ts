import {
  getVoiceOverview,
  organizeMemoryNow,
  purgeProfileVoiceSamples,
  recompileProfileCard,
  updateVoiceProfile,
} from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createInstallationStore,
  FirestoreProfileVoiceOverviewRepository,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { getApplication, getDb, getWorkspace } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const ACTIONS = 'organize, recompile, purge-voice, voice-profile, or forget-all';

/** The distilled writing voice, so the phone can edit the same profile the web does. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
    });
    try {
      const assertConfiguredOwner = async () => {
        const agents = await store.collection('agents').limit(2).get();
        if (
          agents.size !== 1 ||
          agents.docs[0]?.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
          agents.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID
        )
          throw new Error('Voice overview requires one matching configured owner');
      };
      await assertConfiguredOwner();
      const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
      const { voiceStats, voiceProfile } = await getVoiceOverview(
        new FirestoreProfileVoiceOverviewRepository(store, config.FIRESTORE_AGENT_ID),
      );
      await assertConfiguredOwner();
      await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
      return mobileJson({ voiceStats, voiceProfile });
    } finally {
      await store.db.terminate();
    }
  }
  const { voiceStats, voiceProfile } = await getVoiceOverview(getDb());
  return mobileJson({ voiceStats, voiceProfile });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return mobileJson(
      { error: 'Memory profile updates are unavailable in Firestore mode.' },
      { status: 503 },
    );
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    confirm?: unknown;
    description?: unknown;
    dos?: unknown;
    donts?: unknown;
    signature?: unknown;
  } | null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  /**
   * GET hands back `dos`/`donts` as arrays, so a client that reads the profile,
   * edits it and posts it back sends arrays too. The application layer wants
   * the newline-separated form the web textarea produces, and coercing with
   * `text()` alone turned every array into '' — silently erasing both lists
   * while description and signature saved fine. Accept either shape.
   */
  const lines = (value: unknown) =>
    Array.isArray(value) ? value.map(text).join('\n') : text(value);

  try {
    switch (body?.action) {
      case 'organize':
        return mobileJson({ ok: true, ...(await organizeMemoryNow(getDb())) });
      case 'recompile':
        await recompileProfileCard(getDb());
        return mobileJson({ ok: true });
      case 'purge-voice':
        return mobileJson({
          ok: true,
          ...(await purgeProfileVoiceSamples(getDb(), getWorkspace())),
        });
      case 'voice-profile': {
        const result = await updateVoiceProfile(getDb(), {
          description: text(body.description),
          dos: lines(body.dos),
          donts: lines(body.donts),
          signature: text(body.signature),
        });
        if (result.error) return mobileJson({ error: result.error }, { status: 400 });
        return mobileJson({ ok: true });
      }
      // Irreversible, and the one action here the owner can never undo, so it
      // stays explicit rather than riding along with purge-voice. It also wants
      // the intent spelled out a second time: every other action on this route
      // is recoverable, so a malformed or mis-sent body should not be one field
      // away from erasing everything.
      case 'forget-all':
        if (body.confirm !== 'forget-all') {
          return mobileJson(
            { error: 'forget-all requires confirm: "forget-all"' },
            { status: 400 },
          );
        }
        await getApplication().forgetLongTermMemory();
        return mobileJson({ ok: true });
      default:
        return mobileJson({ error: `action must be ${ACTIONS}` }, { status: 400 });
    }
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Memory profile could not be updated.' },
      { status: 409 },
    );
  }
}
