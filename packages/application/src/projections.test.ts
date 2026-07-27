import { createDb, type Db } from '@assistant/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { listApprovalInbox } from './approvals.js';
import { getCostsDashboard } from './costs.js';
import { listGoalsDashboard } from './goals.js';
import { getProfileOverview, listMemoryLibrary } from './profile.js';
import { listActivity } from './tasks.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('application projections', () => {
  let db: Db;
  let dbUp = false;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      await listActivity(db, { archived: false, filter: 'all', limit: 1 });
      dbUp = true;
    } catch {
      console.warn('application projections: database unreachable — skipping');
    }
  });

  it('loads owner-facing dashboard projections through stable contracts', async (context) => {
    if (!dbUp) return context.skip();
    const [approvals, activity, goals, profile, memory, costs] = await Promise.all([
      listApprovalInbox(db, 1),
      listActivity(db, { archived: false, filter: 'all', limit: 1 }),
      listGoalsDashboard(db, false),
      getProfileOverview(db),
      listMemoryLibrary(db, {
        state: 'in-use',
        filter: 'all',
        query: '',
        page: 1,
        pageSize: 1,
      }),
      getCostsDashboard(db),
    ]);

    expect(Array.isArray(approvals.pending)).toBe(true);
    expect(Array.isArray(activity.items)).toBe(true);
    expect(Array.isArray(goals.items)).toBe(true);
    expect(Array.isArray(profile.ownerFacts)).toBe(true);
    expect(memory.total).toBeGreaterThanOrEqual(0);
    expect(costs.totals.monthlySpentUsd).toBeGreaterThanOrEqual(0);
  });
});
