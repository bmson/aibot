import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDb, modelRoles, models } from '@assistant/db';
import { sql } from 'drizzle-orm';

try {
  process.loadEnvFile('.env');
} catch {
  /* Environment may be supplied directly. */
}
const source = process.env.PROD_DATABASE_URL;
if (!source) throw new Error('PROD_DATABASE_URL is required to capture production model settings.');
const destination = process.argv[2] ?? '.workspace/question-regression/model-config.json';
const db = createDb(source, { max: 1 });
try {
  const snapshot = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SET TRANSACTION READ ONLY`);
    return {
      capturedAt: new Date().toISOString(),
      models: await transaction
        .select({
          id: models.id,
          label: models.label,
          capabilities: models.capabilities,
          promptCostPerMTok: models.promptCostPerMTok,
          completionCostPerMTok: models.completionCostPerMTok,
          latencyClass: models.latencyClass,
          enabled: models.enabled,
        })
        .from(models),
      roles: await transaction
        .select({
          role: modelRoles.role,
          primaryModel: modelRoles.primaryModel,
          fallbackModel: modelRoles.fallbackModel,
          params: modelRoles.params,
        })
        .from(modelRoles),
    };
  });
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(
    `Captured ${snapshot.roles.length} model roles to ${destination}. No credentials or conversation data were copied.`,
  );
} finally {
  await db.$client.end();
}
