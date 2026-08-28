import { isModuleEnabled, loadConfig } from '@assistant/config';
import { getAgent } from '@assistant/core/chat';
import {
  assessProactiveHealth,
  type ProactiveHealth,
} from '@assistant/core/proactive/pipeline-health';
import type { Db } from '@assistant/db';

/**
 * "Is the assistant actually able to notice anything?" as a view model.
 *
 * Every proactive producer is self-silencing, which means a broken pipeline and
 * a quiet week look identical from the outside. This is the one surface that
 * tells them apart: what arrived, what was said, what reached the phone, and
 * the specific misconfigurations that would explain a zero.
 */
export interface ProactiveHealthView extends Omit<ProactiveHealth, 'lastMailAt'> {
  /** ISO string, or null — presentation never receives a Date. */
  lastMailAt: string | null;
  /** Everything is arriving and reachable. */
  healthy: boolean;
}

export async function getProactiveHealth(db: Db): Promise<ProactiveHealthView> {
  const config = loadConfig();
  const agent = await getAgent(db);
  const health = await assessProactiveHealth(db, agent.id, {
    ingestMode: config.EMAIL_INGEST_MODE,
    googleEnabled: isModuleEnabled(config, 'google'),
  });
  return {
    ...health,
    lastMailAt: health.lastMailAt?.toISOString() ?? null,
    healthy: health.warnings.length === 0,
  };
}
