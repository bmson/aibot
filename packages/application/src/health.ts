import type { Db } from '@assistant/db';
import { sql } from 'drizzle-orm';

export interface Readiness {
  ready: boolean;
  database: 'ready' | 'unavailable';
}

/**
 * Readiness through an injected probe, for compositions without SQL. The
 * probe resolves true when the configured owner record is readable.
 */
export async function checkReadinessWithProbe(
  probe: () => Promise<boolean>,
): Promise<{ ready: boolean; database: 'firestore' | 'unavailable' }> {
  try {
    return (await probe())
      ? { ready: true, database: 'firestore' }
      : { ready: false, database: 'unavailable' };
  } catch {
    return { ready: false, database: 'unavailable' };
  }
}

/** A deliberately small dependency check suitable for readiness probes. */
export async function checkReadiness(db: Db): Promise<Readiness> {
  try {
    await db.execute(sql`select 1`);
    return { ready: true, database: 'ready' };
  } catch {
    return { ready: false, database: 'unavailable' };
  }
}
