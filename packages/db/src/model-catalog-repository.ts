import { isRoutableModel, type ModelCatalogRepository } from '@assistant/persistence';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { modelRoles, models } from './schema.js';

export function createPostgresModelCatalogRepository(db: Db): ModelCatalogRepository {
  return {
    kind: 'model-catalog-repository',
    listModels: () => db.select().from(models).orderBy(asc(models.label)),
    listRoles: () => db.select().from(modelRoles).orderBy(asc(modelRoles.role)),
    async upsertModel(input) {
      await db
        .insert(models)
        .values(input)
        .onConflictDoUpdate({
          target: models.id,
          set: {
            label: input.label,
            capabilities: input.capabilities,
            promptCostPerMTok: input.promptCostPerMTok,
            completionCostPerMTok: input.completionCostPerMTok,
            latencyClass: input.latencyClass,
            enabled: input.enabled,
            updatedAt: sql`now()`,
          },
        });
    },
    async assignRoles(assignments) {
      if (assignments.length === 0) return;
      await db.transaction(async (tx) => {
        const wanted = [...new Set(assignments.flatMap((a) => [a.primaryModel, a.fallbackModel]))];
        const rows = await tx.select().from(models).where(inArray(models.id, wanted)).for('share');
        const routable = new Set(rows.filter(isRoutableModel).map((row) => row.id));
        for (const id of wanted) {
          if (!routable.has(id)) throw new Error(`Model ${id} is not enabled with prices`);
        }
        for (const assignment of assignments) {
          const updated = await tx
            .update(modelRoles)
            .set({
              primaryModel: assignment.primaryModel,
              fallbackModel: assignment.fallbackModel,
              updatedAt: sql`now()`,
            })
            .where(eq(modelRoles.role, assignment.role))
            .returning({ role: modelRoles.role });
          if (updated.length !== 1) throw new Error(`Unknown model role: ${assignment.role}`);
        }
      });
    },
  };
}
