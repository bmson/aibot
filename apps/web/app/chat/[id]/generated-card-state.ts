export interface CardRefreshAttempt {
  revision: string;
  taskId?: string;
  state: 'saving' | 'refreshing';
}

/** Persisted state wins only when it belongs to the acknowledged refresh attempt. */
export function cardIsRefreshing(
  data: {
    revisionId?: unknown;
    updatedAt?: unknown;
    refreshState?: unknown;
    refreshTaskId?: unknown;
  },
  attempt: CardRefreshAttempt | null,
): boolean {
  if (data.refreshState === 'refreshing') return true;
  if (!attempt) return false;
  const revision =
    typeof data.revisionId === 'string' && data.revisionId
      ? data.revisionId
      : typeof data.updatedAt === 'string'
        ? data.updatedAt
        : '';
  if (attempt.revision !== revision) return false;
  if (
    attempt.taskId &&
    data.refreshTaskId === attempt.taskId &&
    (data.refreshState === 'idle' || data.refreshState === 'failed')
  )
    return false;
  return true;
}
