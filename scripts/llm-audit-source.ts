import { createDb, modelCallAudit } from '@assistant/db';
import { createInstallationStore, decodeRecord } from '@assistant/firestore';
import type { Records } from '@assistant/persistence';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { createGcloudAuthClient } from './gcloud-auth.js';

export type AuditRow = Pick<
  Records['modelCallAudit'],
  | 'id'
  | 'createdAt'
  | 'role'
  | 'model'
  | 'method'
  | 'capture'
  | 'output'
  | 'finishReason'
  | 'latencyMs'
  | 'outputTokens'
  | 'taskId'
>;

export function firestoreAuditTarget(env: NodeJS.ProcessEnv, production: boolean) {
  const projectId = env.GCP_PROJECT?.trim();
  const databaseId = env.FIRESTORE_DATABASE_ID?.trim();
  const installationId = env.ASSISTANT_WORKSPACE_ID?.trim();
  if (!projectId || !databaseId || !installationId) {
    throw new Error(
      'Firestore audit requires GCP_PROJECT, FIRESTORE_DATABASE_ID, and ASSISTANT_WORKSPACE_ID explicitly.',
    );
  }
  if (production && env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Unset FIRESTORE_EMULATOR_HOST before running a production audit.');
  }
  return { projectId, databaseId, installationId };
}

export async function readAuditRows(options: {
  days: number;
  role?: string;
  production: boolean;
  firestore: boolean;
  gcloudAuth: boolean;
}): Promise<AuditRow[]> {
  if (options.firestore) {
    const target = firestoreAuditTarget(process.env, options.production);
    const authClient = options.gcloudAuth ? await createGcloudAuthClient() : undefined;
    const store = createInstallationStore({ ...target, authClient });
    try {
      const since = new Date(Date.now() - options.days * 86_400_000);
      const snapshot = await store
        .collection('modelCallAudit')
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'desc')
        .select(
          'id',
          'createdAt',
          'role',
          'model',
          'method',
          'capture',
          'output',
          'finishReason',
          'latencyMs',
          'outputTokens',
          'taskId',
        )
        .get();
      // Filter after the time query so role-specific reports need no composite index.
      return snapshot.docs
        .map((doc) => decodeRecord<AuditRow>(doc.data()))
        .filter((row) => !options.role || row.role === options.role);
    } finally {
      await store.db.terminate();
    }
  }

  const url = options.production ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      options.production
        ? 'PROD_DATABASE_URL is required with --prod for PostgreSQL. For Firestore, pass --firestore and its target settings.'
        : 'DATABASE_URL is required. Start the database, or pass --firestore to read Firestore.',
    );
  }
  const db = createDb(url, { max: 1 });
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return tx
        .select({
          id: modelCallAudit.id,
          createdAt: modelCallAudit.createdAt,
          role: modelCallAudit.role,
          model: modelCallAudit.model,
          method: modelCallAudit.method,
          capture: modelCallAudit.capture,
          output: modelCallAudit.output,
          finishReason: modelCallAudit.finishReason,
          latencyMs: modelCallAudit.latencyMs,
          outputTokens: modelCallAudit.outputTokens,
          taskId: modelCallAudit.taskId,
        })
        .from(modelCallAudit)
        .where(
          and(
            gte(modelCallAudit.createdAt, sql`now() - make_interval(days => ${options.days})`),
            ...(options.role ? [eq(modelCallAudit.role, options.role)] : []),
          ),
        )
        .orderBy(desc(modelCallAudit.createdAt));
    });
  } finally {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  }
}
