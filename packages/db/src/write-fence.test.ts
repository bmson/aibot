import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { agents } from './schema.js';
import { POSTGRES_SOURCE_WRITE_FENCED, withPostgresSourceWriteFence } from './write-fence.js';

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const hasIsolatedTestDatabase = Boolean(
  TEST_DATABASE_URL && new URL(TEST_DATABASE_URL).pathname.endsWith('_test'),
);

describe('PostgreSQL source write fence', () => {
  const databases: ReturnType<typeof createDb>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.$client.end()));
  });

  it('blocks typed DML and raw SQL while preserving typed reads', () => {
    const db = createDb('postgres://assistant:assistant@127.0.0.1:1/fence_test', {
      sourceWritesFenced: true,
    });
    databases.push(db);

    expect(() => db.insert(agents)).toThrow(POSTGRES_SOURCE_WRITE_FENCED);
    expect(() => db.update(agents)).toThrow(POSTGRES_SOURCE_WRITE_FENCED);
    expect(() => db.delete(agents)).toThrow(POSTGRES_SOURCE_WRITE_FENCED);
    expect(() => db.execute(sql`select 1`)).toThrow('Use typed read queries only');
    expect(() => db.$client.reserve()).toThrow('Raw PostgreSQL access is unavailable');
    expect(() => (db.$client as unknown as (query: string) => unknown)('select 1')).toThrow(
      'Raw PostgreSQL access is unavailable',
    );
    expect(() => db.select().from(agents)).not.toThrow();
  });

  it('applies the same fence to transaction handles and nested query contexts', () => {
    const write = () => undefined;
    const transactionDb = {
      insert: write,
      transaction(callback: (tx: { update: typeof write; execute: typeof write }) => unknown) {
        return callback({ update: write, execute: write });
      },
      $with() {
        return { delete: write };
      },
    };
    const db = withPostgresSourceWriteFence(transactionDb);

    expect(() => db.transaction((tx) => tx.update())).toThrow(POSTGRES_SOURCE_WRITE_FENCED);
    expect(() => db.transaction((tx) => tx.execute())).toThrow('Use typed read queries only');
    expect(() => db.$with().delete()).toThrow(POSTGRES_SOURCE_WRITE_FENCED);
  });

  it('leaves ordinary createDb callers writable unless the fence is explicitly enabled', () => {
    const db = createDb('postgres://assistant:assistant@127.0.0.1:1/fence_test');
    databases.push(db);
    expect(() => db.insert(agents).values({ name: 'test' } as never)).not.toThrow();
  });

  it.skipIf(!hasIsolatedTestDatabase)(
    'executes typed reads through the fenced connection and transaction',
    async () => {
      if (!TEST_DATABASE_URL) throw new Error('DATABASE_URL is required for this test.');
      const db = createDb(TEST_DATABASE_URL, { sourceWritesFenced: true });
      databases.push(db);

      await expect(db.select().from(agents).limit(1)).resolves.toEqual(expect.any(Array));
      await expect(
        db.transaction(async (tx) => tx.select().from(agents).limit(1)),
      ).resolves.toEqual(expect.any(Array));
    },
  );
});
