/** An open improvement proposal the `self.maintain` job triages. */
export interface OpenImprovementProposal {
  id: string;
  kind: string;
  title: string;
  rationale: string;
}

/** A fenced backlog item; the fence in core has already decided its status. */
export interface NewSelfMaintenanceItem {
  title: string;
  diagnosis: string;
  targetArea: string;
  status: 'backlog' | 'blocked';
  blockedReason: string | null;
}

/** The `self.maintain` job's reads and its backlog ledger. Triage and the fence stay in core. */
export interface SelfMaintenanceRepository {
  readonly kind: 'self-maintenance-repository';
  openProposals(agentId: string, limit: number): Promise<OpenImprovementProposal[]>;
  /** Record the item unless one with the same title exists; true when it was new. */
  insert(agentId: string, item: NewSelfMaintenanceItem): Promise<boolean>;
}
