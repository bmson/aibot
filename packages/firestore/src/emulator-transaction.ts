/**
 * The emulator occasionally reports a contended transaction as code 3
 * ("Transaction is invalid or closed.") instead of retryable ABORTED. Callers
 * whose transaction is idempotent may retry this emulator-only response after
 * the competing commit settles; production Firestore never takes this path.
 */
export function isEmulatorClosedTransaction(error: unknown): boolean {
  return (
    Boolean(process.env.FIRESTORE_EMULATOR_HOST) &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 3 &&
    'details' in error &&
    error.details === 'Transaction is invalid or closed.'
  );
}
