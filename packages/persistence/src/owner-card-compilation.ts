/** Explicit safety ceilings; current imported installations are checked before raising them. */
export const MAX_OWNER_CARD_CONTACT_SCAN = 10_000;
export const MAX_OWNER_CARD_MEMORY_SCAN = 10_000;

export interface OwnerCardFactInput {
  content: string;
  domain: string | null;
  importance: number;
  confidence: string;
  pinned: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
}

export interface OwnerCardPersonInput {
  id: string;
  name: string;
  relationship: string;
  factCount: number;
  pinnedFacts: string[];
}

export interface OwnerCardCompilationInput {
  ownerFacts: OwnerCardFactInput[];
  people: OwnerCardPersonInput[];
}

export interface OwnerCardCompilationRepository {
  readonly kind: 'owner-card-compilation-repository';
  /**
   * Read a consistent compilation input, render it in core, and publish the result.
   * Implementations serialize this operation with immediate memory supersession.
   */
  compile(input: {
    agentId: string;
    now: Date;
    render: (input: OwnerCardCompilationInput) => string;
  }): Promise<string>;
}

export function isOwnerCardCompilationRepository(
  value: unknown,
): value is OwnerCardCompilationRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'owner-card-compilation-repository'
  );
}
