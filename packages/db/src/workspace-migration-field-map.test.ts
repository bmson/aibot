import { MIGRATION_TABLES, type MigrationTable } from '@assistant/persistence';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';
import { migrationColumnFieldName } from './workspace-migration.js';

describe('PostgreSQL to Firestore field names', () => {
  it('matches every declared Drizzle field, including acronym spellings', () => {
    const supported = new Set(MIGRATION_TABLES.map(({ table }) => table));
    const found = new Set<string>();
    let columns = 0;
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const table = getTableName(value);
      if (!supported.has(table as MigrationTable)) continue;
      found.add(table);
      for (const [field, column] of Object.entries(getTableColumns(value))) {
        expect(
          migrationColumnFieldName(table as MigrationTable, column.name),
          `${table}.${column.name}`,
        ).toBe(field);
        columns++;
      }
    }
    expect(found).toEqual(supported);
    expect(columns).toBeGreaterThan(700);
  });
});
