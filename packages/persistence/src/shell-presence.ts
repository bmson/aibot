export type ShellPresence = 'idle' | 'working' | 'attention';

/** Narrow status poll read model; it must not load memory-health collections. */
export interface ShellPresenceRepository {
  readonly kind: 'shell-presence-repository';
  load(agentId: string): Promise<ShellPresence>;
}

export function isShellPresenceRepository(value: unknown): value is ShellPresenceRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'shell-presence-repository' &&
    'load' in value &&
    typeof value.load === 'function'
  );
}
