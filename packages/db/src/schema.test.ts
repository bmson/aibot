import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

const EXPECTED_TABLES = [
  'agents',
  'goals',
  'conversations',
  'channel_bindings',
  'messages',
  'tasks',
  'tool_calls',
  'approvals',
  'approval_policies',
  'memories',
  'contacts',
  'models',
  'model_roles',
  'model_calls',
  'budgets',
  'tool_cache',
  'rate_limits',
  'writing_samples',
  'voice_profile',
  'gmail_sync_state',
  'schedules',
  'canary_runs',
  'files',
];

describe('schema', () => {
  it('defines every table from the plan', () => {
    const tableNames = Object.values(schema)
      .filter((v) => typeof v === 'object' && v !== null)
      .flatMap((v) => {
        try {
          return [getTableName(v as Parameters<typeof getTableName>[0])];
        } catch {
          return [];
        }
      });
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames, `missing table ${expected}`).toContain(expected);
    }
  });

  it('tasks carries the checkpoint + mission columns', () => {
    const cols = getTableColumns(schema.tasks);
    for (const col of [
      'state',
      'plan',
      'trigger',
      'progress',
      'progressPercent',
      'nextAction',
      'deadline',
      'reflectEvery',
      'lastReflectedAt',
      'externalEventId',
      'lockedUntil',
      'budgetUsdLimit',
      'spentUsd',
      'parentTaskId',
      'goalId',
    ]) {
      expect(cols, `missing tasks column ${col}`).toHaveProperty(col);
    }
  });

  it('tool_calls carries decision provenance and idempotency', () => {
    const cols = getTableColumns(schema.toolCalls);
    expect(cols).toHaveProperty('decision');
    expect(cols).toHaveProperty('idempotencyKey');
  });

  it('memories carries category/confidence/quarantine', () => {
    const cols = getTableColumns(schema.memories);
    expect(cols).toHaveProperty('category');
    expect(cols).toHaveProperty('confidence');
    expect(cols).toHaveProperty('quarantined');
  });
});
