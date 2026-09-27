import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresModelCatalogRepository } from './model-catalog-repository.js';
import { createPostgresModelConnectionRepository } from './model-connection-repository.js';
import { modelConnections, modelRoles, models } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL model connections and catalog', () => {
  const suffix = randomUUID().slice(0, 8);
  const priced = `openai:priced-${suffix}`;
  const unpriced = `openai:unpriced-${suffix}`;
  const gateway = `gw-${suffix}`;
  let db: Db;
  let dbUp = false;
  let original: { primaryModel: string; fallbackModel: string } | undefined;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      [original] = await db
        .select({ primaryModel: modelRoles.primaryModel, fallbackModel: modelRoles.fallbackModel })
        .from(modelRoles)
        .where(eq(modelRoles.role, 'batch'));
      dbUp = Boolean(original);
    } catch {
      console.warn('model-catalog-repository.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp || !original) return;
    await db.update(modelRoles).set(original).where(eq(modelRoles.role, 'batch'));
    await db.delete(models).where(inArray(models.id, [priced, unpriced]));
    await db.delete(modelConnections).where(eq(modelConnections.id, gateway));
  });

  it('stores connections and keeps the sealed key unless replaced', async () => {
    if (!dbUp) return;
    const repo = createPostgresModelConnectionRepository(db);
    const base = {
      id: gateway,
      kind: 'openai_compatible',
      label: 'Gateway',
      baseUrl: 'https://gateway.test/v1',
      vertexProject: null,
      vertexLocation: null,
      enabled: true,
    };
    await repo.upsert({ ...base, apiKeyEncrypted: 'v2.sealed' });
    const renamed = await repo.upsert({ ...base, label: 'Renamed' });
    expect(renamed).toMatchObject({ label: 'Renamed', apiKeyEncrypted: 'v2.sealed' });
    expect(await repo.recordTest(gateway, { ok: false, error: 'HTTP 401' })).toBe(true);
    const [row] = (await repo.list()).filter((candidate) => candidate.id === gateway);
    expect(row).toMatchObject({ lastError: 'HTTP 401', updatedAt: renamed.updatedAt });
    expect(await repo.setEnabled(gateway, false)).toBe(true);
    expect(await repo.remove(gateway)).toBe(true);
    expect(await repo.remove(gateway)).toBe(false);
  });

  it('assigns a role only to enabled, priced models, atomically', async () => {
    if (!dbUp) return;
    const catalog = createPostgresModelCatalogRepository(db);
    const model = (id: string, promptCostPerMTok: string | null) => ({
      id,
      label: id,
      capabilities: { tools: true },
      promptCostPerMTok,
      completionCostPerMTok: '2.0000',
      latencyClass: 'medium',
      enabled: true,
    });
    await catalog.upsertModel(model(priced, '1.0000'));
    await catalog.upsertModel(model(unpriced, null));

    await expect(
      catalog.assignRoles([{ role: 'batch', primaryModel: priced, fallbackModel: unpriced }]),
    ).rejects.toThrow('not enabled with prices');
    await expect(
      catalog.assignRoles([
        { role: 'batch', primaryModel: priced, fallbackModel: priced },
        { role: 'nope', primaryModel: priced, fallbackModel: priced },
      ]),
    ).rejects.toThrow();
    const [unchanged] = (await catalog.listRoles()).filter((row) => row.role === 'batch');
    expect(unchanged?.primaryModel).toBe(original?.primaryModel);

    await catalog.assignRoles([{ role: 'batch', primaryModel: priced, fallbackModel: priced }]);
    const [batch] = (await catalog.listRoles()).filter((row) => row.role === 'batch');
    expect(batch).toMatchObject({ primaryModel: priced, fallbackModel: priced });
  });
});
