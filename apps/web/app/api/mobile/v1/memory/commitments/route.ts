import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreCommitmentMutationRepository,
  getFirestoreCommitmentOverview,
} from '@assistant/firestore';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const ACTIONS = 'resolve, snooze, dismiss, or correct';
/** Matches the web hub's snooze: one day, chosen by the action rather than the caller. */
const SNOOZE_MS = 24 * 3600 * 1000;

/**
 * Open loops the assistant is tracking. The memory desk has always had these on
 * the web; the phone had no way to reach them at all, so a commitment could be
 * raised in conversation and then only ever be resolved from a browser.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  const commitments = await (async () => {
    if (config.PERSISTENCE_DRIVER !== 'firestore') return getApplication().listCommitments();
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    return getFirestoreCommitmentOverview(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
      new Date(),
    );
  })();
  return mobileJson({
    commitments: commitments.map((row) => ({
      ...row,
      // Dates cross the wire as strings everywhere else in this API.
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    id?: unknown;
    title?: unknown;
    details?: unknown;
    nextAction?: unknown;
  } | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id) return mobileJson({ error: 'id is required' }, { status: 400 });
  const text = (value: unknown) => (typeof value === 'string' ? value : '');

  /**
   * Every one of these reports "nothing matched" by returning false rather than
   * throwing — the loop was closed by someone else, already resolved, or the id
   * is stale. Ignoring that told the phone a correction had saved when no row
   * had changed, and the editor closed over the unsaved edit.
   */
  const settled = (changed: boolean) =>
    changed
      ? mobileJson({ ok: true })
      : mobileJson({ error: 'That loop is no longer open.' }, { status: 409 });

  let firestoreMutations: FirestoreCommitmentMutationRepository | null = null;
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    firestoreMutations = new FirestoreCommitmentMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
  }
  const firestore = firestoreMutations;
  const operations = firestore
    ? {
        resolve: (commitmentId: string, resolution: string) =>
          firestore.resolve(commitmentId, resolution),
        snooze: (commitmentId: string, until: Date) => firestore.snooze(commitmentId, until),
        dismiss: (commitmentId: string) => firestore.dismiss(commitmentId),
        correct: (
          commitmentId: string,
          patch: { title: string; details: string; nextAction: string },
        ) => firestore.correct(commitmentId, patch),
      }
    : {
        resolve: (commitmentId: string, resolution: string) =>
          getApplication().resolveCommitment(commitmentId, resolution),
        snooze: (commitmentId: string, until: Date) =>
          getApplication().snoozeCommitment(commitmentId, until),
        dismiss: (commitmentId: string) => getApplication().dismissCommitment(commitmentId),
        correct: (
          commitmentId: string,
          patch: { title: string; details: string; nextAction: string },
        ) => getApplication().correctCommitment(commitmentId, patch),
      };

  try {
    switch (body?.action) {
      case 'resolve':
        return settled(await operations.resolve(id, 'Owner confirmed this loop is resolved.'));
      case 'snooze':
        return settled(await operations.snooze(id, new Date(Date.now() + SNOOZE_MS)));
      case 'dismiss':
        return settled(await operations.dismiss(id));
      case 'correct': {
        // The web form requires a title; an empty one would blank the loop's
        // only identifying text rather than correct it.
        const title = text(body.title).trim();
        if (!title) return mobileJson({ error: 'title is required' }, { status: 400 });
        return settled(
          await operations.correct(id, {
            title,
            details: text(body.details),
            nextAction: text(body.nextAction),
          }),
        );
      }
      default:
        return mobileJson({ error: `action must be ${ACTIONS}` }, { status: 400 });
    }
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'That loop could not be updated.' },
      { status: 409 },
    );
  }
}
