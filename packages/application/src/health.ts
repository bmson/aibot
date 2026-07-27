import type { Db } from '@assistant/db';
import { sql } from 'drizzle-orm';

export interface Readiness {
  ready: boolean;
  database: 'ready' | 'unavailable';
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
