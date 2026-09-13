import type { Records } from './records.js';

export type OwnerCardSnapshot = Pick<Records['ownerCard'], 'content' | 'compiledAt'>;
export type OwnerAmbientSnapshot = Pick<
  Records['ambientSnapshots'],
  'agentId' | 'block' | 'flags' | 'sources' | 'computedAt'
>;
export type OwnerLocationPing = Records['locationPings'];
export type OwnerCommitment = Records['commitments'];

/**
 * Read-only data needed to assemble the private context for an owner chat.
 *
 * Implementations must treat `agentId` as an authorization boundary. Rendering,
 * freshness decisions, and lexical ranking stay in core so every backend injects
 * the same prompt text from the same stored values.
 */
export interface OwnerContextRepository {
  readonly kind: 'owner-context-repository';

  getOwnerCard(agentId: string): Promise<OwnerCardSnapshot | null>;
  getAmbientSnapshot(agentId: string): Promise<OwnerAmbientSnapshot | null>;
  getLatestLocation(input: {
    agentId: string;
    notBefore: Date;
    notAfter: Date;
    source?: string;
  }): Promise<OwnerLocationPing | null>;
  /** Active candidates, newest first. Core applies query ranking and its final limit. */
  listOpenCommitments(input: {
    agentId: string;
    now: Date;
    limit: number;
  }): Promise<OwnerCommitment[]>;
}

export function isOwnerContextRepository(value: unknown): value is OwnerContextRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'owner-context-repository'
  );
}
