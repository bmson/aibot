import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { InstallationStore } from '@assistant/firestore';
import {
  explainDueTaskQuery,
  type ValidationFieldOverride,
  type ValidationIndex,
  withValidationDatabase,
} from '@assistant/firestore/validation-admin';
import { firestoreApplicationSmoke } from './firestore-application-smoke.js';
import { firestoreApprovalSmoke } from './firestore-approval-smoke.js';
import { firestoreChatSmoke } from './firestore-chat-smoke.js';
import { firestoreExecutorSmoke } from './firestore-executor-smoke.js';
import { firestoreRuntimeSmoke } from './firestore-runtime-smoke.js';
import { firestoreScheduleSmoke } from './firestore-schedule-smoke.js';
import { firestoreSettingsSmoke } from './firestore-settings-smoke.js';
import { firestoreTaskSmoke } from './firestore-task-smoke.js';
import { firestoreWatchSmoke } from './firestore-watch-smoke.js';
import { createGcloudAuthClient } from './gcloud-auth.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    location: { type: 'string', default: 'us-west1' },
    run: { type: 'boolean', default: false },
    'gcloud-auth': { type: 'boolean', default: false },
  },
});
if (!values.project)
  throw new Error(
    'Usage: pnpm firestore:validate --project PROJECT [--location REGION] [--gcloud-auth] [--run]',
  );
const spec = JSON.parse(
  await readFile(new URL('../infra/gcp/firestore/firestore.indexes.json', import.meta.url), 'utf8'),
) as { indexes: ValidationIndex[]; fieldOverrides: ValidationFieldOverride[] };
const indexes = spec.indexes.filter((index) =>
  [
    'tasks',
    'outbox',
    'schedules',
    'approvals',
    'approvalPolicies',
    'toolCalls',
    'messages',
    'conversations',
    'models',
    'generatedCards',
    'conversationSegments',
    'memories',
    'knowledgeGraphRelations',
    'skills',
    'locationPings',
    'commitments',
    'watches',
    'proactivePings',
  ].includes(index.collectionGroup),
);
const input = {
  projectId: values.project,
  location: values.location ?? 'us-west1',
  indexes,
  fieldOverrides: spec.fieldOverrides,
  progress: (stage: string, details: Record<string, unknown>) =>
    console.log(JSON.stringify({ stage, ...details })),
};
if (!values.run) {
  console.log(
    JSON.stringify(
      {
        projectId: input.projectId,
        location: input.location,
        database: 'new assistant-validation-* database; never (default)',
        indexes: indexes.length,
        fieldOverrides: input.fieldOverrides.length,
        data: 'synthetic tasks, reminders, approvals, profile memory and routing telemetry; no model requests',
        cleanup: 'delete the database after success or failure',
        authentication: values['gcloud-auth']
          ? 'Active gcloud CLI account, pinned in memory for this development-only run'
          : 'Application Default Credentials with Firestore database/index administration',
        billing: 'Uses billable Google resources. Run only in the intended test project.',
        execute: 'Add --run to perform live validation',
      },
      null,
      2,
    ),
  );
} else {
  // Enable optional context before the first workload loads the cached configuration.
  process.env.CHAT_RECALL_ENABLED = 'true';
  process.env.GRAPH_RAG_ENABLED = 'true';
  const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
  const report = await withValidationDatabase({ ...input, authClient }, async (store) => {
    const applicationStore = new InstallationStore(
      store.db,
      `${store.installationId}-application`,
      store.now,
      store.projectId,
      store.databaseId,
    );
    return {
      ...(await firestoreTaskSmoke(store)),
      dueTaskQueryExplain: await explainDueTaskQuery(store),
      schedules: await firestoreScheduleSmoke(store),
      settings: await firestoreSettingsSmoke(store),
      approvals: await firestoreApprovalSmoke(store),
      runtime: await firestoreRuntimeSmoke(store),
      executor: await firestoreExecutorSmoke(store),
      chat: await firestoreChatSmoke(store, { recall: true }),
      application: await firestoreApplicationSmoke(applicationStore),
      watches: await firestoreWatchSmoke(store),
    };
  });
  console.log(JSON.stringify({ stage: 'complete', ...report }, null, 2));
}
