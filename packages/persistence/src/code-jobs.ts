/**
 * The lease a running code job holds. Portable job writers commit only while
 * the task still owns it, so a job whose lease was reclaimed cannot write after
 * the new holder started.
 */
export interface CodeJobLease {
  taskId: string;
  leaseToken: string;
}
