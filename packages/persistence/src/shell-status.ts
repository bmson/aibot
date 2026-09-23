export interface ShellStatusProjection {
  dashboard: {
    pendingApprovals: number;
    needsAttention: number;
    presence: 'idle' | 'working' | 'attention';
  };
  memoryHealth: {
    totalUsable: number;
    notYetOrganized: number;
    awaitingReview: number;
    ownerConfirmed: number;
    lastOrganizedAt: Date | null;
  };
}

/** Owner-scoped status read model used by native bootstrap and the web shell. */
export interface ShellStatusRepository {
  readonly kind: 'shell-status-repository';
  load(agentId: string): Promise<ShellStatusProjection>;
}

export function isShellStatusRepository(value: unknown): value is ShellStatusRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'shell-status-repository' &&
    'load' in value &&
    typeof value.load === 'function'
  );
}
