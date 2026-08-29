import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createDb } from '@assistant/db';
import { sql } from 'drizzle-orm';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const apply = process.argv.includes('--apply');
const outputArg = process.argv.find((argument) => argument.startsWith('--backup='));
const backupPath = resolve(
  outputArg?.slice('--backup='.length) ??
    `.workspace/backups/knowledge-graph-fixtures-${new Date().toISOString().replaceAll(':', '-')}.json`,
);
const db = createDb(databaseUrl);

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows?: T[] }).rows ?? []) as T[];
  }
  return [];
}

try {
  const snapshot = {
    createdAt: new Date().toISOString(),
    database: new URL(databaseUrl).pathname.slice(1),
    memories: rows(
      await db.execute(sql`
        SELECT * FROM memories
        WHERE content LIKE 'xtest-kgview-%'
           OR content_hash LIKE 'xtest-kgview-%'
      `),
    ),
    sources: rows(
      await db.execute(sql`
        SELECT source.* FROM knowledge_graph_sources AS source
        INNER JOIN memories AS memory ON memory.id = source.memory_id
        WHERE memory.content LIKE 'xtest-kgview-%'
           OR memory.content_hash LIKE 'xtest-kgview-%'
      `),
    ),
    relations: rows(
      await db.execute(sql`
        SELECT relation.* FROM knowledge_graph_relations AS relation
        WHERE relation.source_memory_id IN (
          SELECT id FROM memories
          WHERE content LIKE 'xtest-kgview-%'
             OR content_hash LIKE 'xtest-kgview-%'
        )
      `),
    ),
    entities: rows(
      await db.execute(sql`
        SELECT * FROM knowledge_graph_entities
        WHERE canonical_key LIKE '%xtest-kgview-%'
      `),
    ),
    agents: rows(
      await db.execute(sql`
        SELECT * FROM agents WHERE email LIKE 'xtest-kgview-%@example.com'
      `),
    ),
    health: rows<{ orphan_entity_count: number; relation_count: number }>(
      await db.execute(sql`
        SELECT
          (
            SELECT COUNT(*)::int FROM knowledge_graph_entities AS entity
            WHERE NOT EXISTS (
              SELECT 1 FROM knowledge_graph_relations AS relation
              WHERE relation.subject_entity_id = entity.id
                 OR relation.object_entity_id = entity.id
            )
          ) AS orphan_entity_count,
          (SELECT COUNT(*)::int FROM knowledge_graph_relations) AS relation_count
      `),
    )[0] ?? { orphan_entity_count: 0, relation_count: 0 },
  };

  const entityCount = snapshot.entities.length;
  const memoryCount = snapshot.memories.length;
  console.log(
    `${apply ? 'Repairing' : 'Would repair'} ${entityCount} fixture entities and ${memoryCount} fixture memories.`,
  );
  console.log(
    `Graph health: ${snapshot.health.orphan_entity_count} orphan entities and ${snapshot.health.relation_count} relations.`,
  );
  if (!apply) {
    console.log(
      'Dry run only. Pass --apply to export the rows and perform the guarded transaction.',
    );
  } else {
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM memories
        WHERE content LIKE 'xtest-kgview-%'
           OR content_hash LIKE 'xtest-kgview-%'
      `);
      await tx.execute(sql`
        DELETE FROM knowledge_graph_entities
        WHERE canonical_key LIKE '%xtest-kgview-%'
      `);
      await tx.execute(sql`
        DELETE FROM agents WHERE email LIKE 'xtest-kgview-%@example.com'
      `);
    });
    console.log(`Backup written to ${backupPath}`);
  }
} finally {
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
}
