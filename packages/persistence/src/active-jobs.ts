/** A queued or running code-job task, as owner-facing triggers need to see it. */
export interface ActiveJobTask {
  id: string;
  status: 'pending' | 'running';
}

/** Finds an owner's unfinished task for one code job, so triggers stay idempotent. */
export interface ActiveJobLookup {
  readonly kind: 'active-job-lookup';
  findActive(agentId: string, job: string): Promise<ActiveJobTask | null>;
}
