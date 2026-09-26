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

/**
 * Run an idempotent transaction, retrying the emulator-only closed-transaction
 * response twice after the competing commit settles. Production errors and any
 * other code pass straight through.
 */
export async function withEmulatorTransactionRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isEmulatorClosedTransaction(error) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

const patched = new WeakSet<object>();

/**
 * Give every transaction on an emulator-backed client the same bounded retry.
 * A transaction callback must already be safe to re-run (the SDK re-runs it on
 * ABORTED), and the closed-transaction response is raised before any commit,
 * so this is the SDK's own retry extended to the emulator's misreported code.
 * A client talking to production Firestore is never patched.
 */
export function retryEmulatorTransactions(db: {
  runTransaction: (...args: never[]) => Promise<unknown>;
}): void {
  if (!process.env.FIRESTORE_EMULATOR_HOST || patched.has(db)) return;
  patched.add(db);
  const run = db.runTransaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  (db as { runTransaction: (...args: unknown[]) => Promise<unknown> }).runTransaction = (
    ...args: unknown[]
  ) => withEmulatorTransactionRetry(() => run(...args));
}
