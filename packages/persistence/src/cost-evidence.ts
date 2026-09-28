/** Missing evidence (including historical events) must never imply a verified charge. */
export type CostBasis = 'provider_reported' | 'token_rate' | 'preflight_estimate' | 'unknown';

export interface CostEvidence {
  basis: CostBasis;
  provider?: string;
  model?: string;
  requestId?: string;
}

export const COST_BASIS_LABELS: Record<CostBasis, string> = {
  provider_reported: 'Provider-reported',
  token_rate: 'Estimated from usage and rates',
  preflight_estimate: 'Estimated without complete usage',
  unknown: 'Unverified / historical',
};

export function costBasis(evidence: CostEvidence | null | undefined): CostBasis {
  return evidence?.basis && Object.hasOwn(COST_BASIS_LABELS, evidence.basis)
    ? evidence.basis
    : 'unknown';
}

export interface CostEvidenceTotal {
  basis: CostBasis;
  usd: string;
  count: number;
}
