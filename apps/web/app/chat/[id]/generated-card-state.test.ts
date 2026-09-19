import { describe, expect, it } from 'vitest';
import { cardIsRefreshing } from './generated-card-state';

describe('saved-card refresh reconciliation', () => {
  const attempt = { revision: 'r1', taskId: 'new-task', state: 'refreshing' as const };
  it('ignores stale failed/idle metadata from a previous attempt', () => {
    for (const refreshState of ['idle', 'failed']) {
      expect(
        cardIsRefreshing({ revisionId: 'r1', refreshState, refreshTaskId: 'old-task' }, attempt),
      ).toBe(true);
    }
  });
  it('settles both failure and unchanged successful refreshes for the current attempt', () => {
    for (const refreshState of ['idle', 'failed']) {
      expect(
        cardIsRefreshing({ revisionId: 'r1', refreshState, refreshTaskId: 'new-task' }, attempt),
      ).toBe(false);
    }
  });
  it('settles a new revision and follows in-flight refreshes from another client', () => {
    expect(cardIsRefreshing({ revisionId: 'r2', refreshState: 'idle' }, attempt)).toBe(false);
    expect(cardIsRefreshing({ revisionId: 'r2', refreshState: 'refreshing' }, null)).toBe(true);
  });
  it('keeps controls busy while the refresh request itself has not been acknowledged', () => {
    expect(
      cardIsRefreshing(
        { revisionId: 'r1', refreshState: 'failed' },
        { revision: 'r1', state: 'saving' },
      ),
    ).toBe(true);
  });
});
