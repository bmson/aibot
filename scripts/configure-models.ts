import { createDb, modelRoles, models, reconcileModelConfig } from '@assistant/db';

try {
  process.loadEnvFile('.env');
} catch {
  /* Environment can be supplied directly. */
}
const production = process.argv.includes('--prod');
const databaseUrl = production ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error(`${production ? 'PROD_DATABASE_URL' : 'DATABASE_URL'} is required`);
const db = createDb(databaseUrl, { max: 1 });
try {
  await reconcileModelConfig(db, true);
  console.log(
    JSON.stringify(
      {
        target: production ? 'production' : 'local',
        roles: await db.select().from(modelRoles),
        models: await db.select({ id: models.id, enabled: models.enabled }).from(models),
      },
      null,
      2,
    ),
  );
} finally {
  await db.$client.end();
}
