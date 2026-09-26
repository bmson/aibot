import type { Records } from './records.js';

export interface AutoExecution {
  id: string;
  toolName: string;
  policyId: string;
  createdAt: Date;
}

export type NewAnomaly = Pick<
  Records['anomalies'],
  | 'kind'
  | 'policyId'
  | 'toolName'
  | 'observed'
  | 'expected'
  | 'toolCallIds'
  | 'detail'
  | 'windowLabel'
  | 'subjectKey'
>;

/** The nightly approval-anomaly scan's reads and its deduped anomaly ledger. */
export interface AnomalyScanRepository {
  readonly kind: 'anomaly-scan-repository';
  policies(agentId: string): Promise<Array<{ id: string; toolName: string }>>;
  /**
   * Autonomous tool calls that succeeded or are executing since `since` and
   * were allowed by one of `policyIds`.
   */
  autoExecutions(agentId: string, since: Date, policyIds: string[]): Promise<AutoExecution[]>;
  /** Observed counts of dismissed frequency anomalies, which raise each policy's floor. */
  dismissedFrequency(agentId: string): Promise<Array<{ policyId: string; observed: number }>>;
  /**
   * Record anomalies once per `(agentId, kind, subjectKey, windowLabel)`;
   * returns only the ones this call created.
   */
  insert(agentId: string, anomalies: NewAnomaly[]): Promise<Records['anomalies'][]>;
}
