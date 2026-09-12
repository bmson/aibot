import { describe, expect, it } from 'vitest';
import { diagnoseSchema } from './diagnose-schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const isSafeTestDatabase = (() => {
  if (!DATABASE_URL) return false;
  try {
    return new URL(DATABASE_URL).pathname.endsWith('_test');
  } catch {
    return false;
  }
})();

describe('schema diagnostic', () => {
  it('reports metadata without exposing connection credentials', async (ctx) => {
    if (!isSafeTestDatabase || !DATABASE_URL) return ctx.skip();

    const report = await diagnoseSchema(DATABASE_URL);
    const serialized = JSON.stringify(report);

    expect(report.connection.database).toBeTruthy();
    expect(report.connection.searchPath).toBeTruthy();
    expect(Array.isArray(report.connection.schemas)).toBe(true);
    expect(Array.isArray(report.agents)).toBe(true);
    expect(report.journal.schema).toBe('drizzle');
    expect(report.journal.table).toBe('__drizzle_migrations');
    expect(report.journal.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.tableCountsBySchema)).toBe(true);
    expect(serialized).not.toContain(DATABASE_URL);
  });
});
