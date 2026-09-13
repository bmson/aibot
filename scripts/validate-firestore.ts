import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  explainDueTaskQuery,
  type ValidationIndex,
  withValidationDatabase,
} from '@assistant/firestore/validation-admin';
import { firestoreApprovalSmoke } from './firestore-approval-smoke.js';
import { firestoreExecutorSmoke } from './firestore-executor-smoke.js';
import { firestoreRuntimeSmoke } from './firestore-runtime-smoke.js';
import { firestoreScheduleSmoke } from './firestore-schedule-smoke.js';
import { firestoreTaskSmoke } from './firestore-task-smoke.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    location: { type: 'string', default: 'us-west1' },
    run: { type: 'boolean', default: false },
  },
});
if (!values.project)
  throw new Error('Usage: pnpm firestore:validate --project PROJECT [--location REGION] [--run]');
const spec = JSON.parse(
  await readFile(new URL('../infra/gcp/firestore/firestore.indexes.json', import.meta.url), 'utf8'),
) as { indexes: ValidationIndex[] };
const indexes = spec.indexes.filter((index) =>
  [
    'tasks',
    'outbox',
    'schedules',
    'approvals',
    'approvalPolicies',
    'toolCalls',
    'messages',
  ].includes(index.collectionGroup),
);
const input = {
  projectId: values.project,
  location: values.location ?? 'us-west1',
  indexes,
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
        data: 'synthetic tasks, reminders, approvals and routing telemetry; no model requests',
        cleanup: 'delete the database after success or failure',
        authentication:
          'Application Default Credentials with Firestore database/index administration',
        billing: 'Uses billable Google resources. Run only in the intended test project.',
        execute: 'Add --run to perform live validation',
      },
      null,
      2,
    ),
  );
} else {
  const report = await withValidationDatabase(input, async (store) => ({
    ...(await firestoreTaskSmoke(store)),
    dueTaskQueryExplain: await explainDueTaskQuery(store),
    schedules: await firestoreScheduleSmoke(store),
    approvals: await firestoreApprovalSmoke(store),
    runtime: await firestoreRuntimeSmoke(store),
    executor: await firestoreExecutorSmoke(store),
  }));
  console.log(JSON.stringify({ stage: 'complete', ...report }, null, 2));
}
