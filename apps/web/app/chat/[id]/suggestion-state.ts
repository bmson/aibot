export type SuggestionStatus =
  | 'pending'
  | 'accepted'
  | 'dismissed'
  | 'snoozed'
  | 'expired'
  | 'missing';

export interface SuggestionResolution {
  status: SuggestionStatus;
  snoozedUntil?: string;
}

export function acceptedSuggestionLabel(taskStatus?: string): string {
  switch (taskStatus) {
    case 'done':
      return 'Completed';
    case 'failed':
      return 'Couldn’t complete';
    case 'cancelled':
      return 'Cancelled';
    case 'waiting_approval':
    case 'waiting_budget':
    case 'needs_attention':
      return 'Needs attention';
    case 'waiting_event':
    case 'sleeping':
      return 'Waiting';
    case 'pending':
      return 'Queued';
    case 'running':
      return 'Working on it';
    default:
      return 'Accepted';
  }
}

export function suggestionTaskIsActive(status?: string): boolean {
  return !!status && !['done', 'failed', 'cancelled'].includes(status);
}

/** A saved answer survives stale polls; a snooze must eventually wake again. */
export function suggestionStatus(
  server: SuggestionStatus | undefined,
  local: SuggestionResolution | undefined,
  now = Date.now(),
): SuggestionStatus {
  if (server && server !== 'pending' && server !== 'snoozed') return server;
  if (!local) return server ?? 'pending';
  if (local.status === 'snoozed' && Date.parse(local.snoozedUntil ?? '') <= now) {
    return server ?? 'pending';
  }
  return local.status;
}
