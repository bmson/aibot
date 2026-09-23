import { listApprovalInbox } from '@assistant/application/approvals';
import { listGoalsDashboardWithRepository } from '@assistant/application/goals';
import { listActivityWithRepository } from '@assistant/application/tasks';
import { isModuleEnabled, loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreApprovalRepository,
  FirestoreDocumentReadRepository,
  FirestoreGoalReadRepository,
  FirestoreTaskActivityRepository,
} from '@assistant/firestore';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Owner-facing secondary surfaces used by the native tab bar. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const validationConfig = {
      ...config,
      ASSISTANT_MODULES: config.ASSISTANT_MODULES.filter((module) => module !== 'documents'),
    };
    const problems = validateAgentPersistenceConfig(validationConfig);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const store = getFirestoreInstallationStore();
    try {
      const [activity, goals, approvals, documents] = await Promise.all([
        listActivityWithRepository(
          new FirestoreTaskActivityRepository(store),
          config.FIRESTORE_AGENT_ID,
          {
            archived: false,
            filter: 'all',
            limit: 50,
          },
        ),
        listGoalsDashboardWithRepository(
          new FirestoreGoalReadRepository(store, config.FIRESTORE_AGENT_ID),
          config.FIRESTORE_AGENT_ID,
          false,
        ),
        listApprovalInbox(
          { agentId: config.FIRESTORE_AGENT_ID, approvals: new FirestoreApprovalRepository(store) },
          20,
        ),
        isModuleEnabled(config, 'documents')
          ? new FirestoreDocumentReadRepository(store, config.FIRESTORE_AGENT_ID)
              .list(config.FIRESTORE_AGENT_ID)
              .then((result) => result)
          : Promise.resolve({
              documents: [],
              stats: { total: 0, ready: 0, pending: 0, chunks: 0 },
              primaryConversationId: null,
            }),
      ]);
      return mobileJson({
        generatedAt: new Date().toISOString(),
        activity,
        goals,
        approvals,
        documents,
      });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Mobile overview is unavailable.' },
        { status: 503 },
      );
    }
  }
  const application = getApplication();
  const [activity, goals, approvals, documents] = await Promise.all([
    application.listActivity({ archived: false, filter: 'all', limit: 50 }),
    application.listGoals(false),
    application.listApprovals(),
    application.getDocuments(),
  ]);
  return mobileJson({
    generatedAt: new Date().toISOString(),
    activity,
    goals,
    approvals,
    documents,
  });
}
