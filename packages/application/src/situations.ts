import {
  commandSituationPack,
  getSituationPack,
  listPackSources,
  listSituationPacks,
} from '@assistant/core/situations';
import type { Db } from '@assistant/db';

export type {
  PackCommand,
  SituationPackView,
  SituationPreview,
  SituationResult,
} from '@assistant/core/situations';
export { getSituationPack, listPackSources, listSituationPacks };

/** Call only after authenticating the owner. The core still checks every row. */
export function changeOwnerPack(db: Db, agentId: string, command: unknown) {
  return commandSituationPack(db, agentId, command, { ownerConfirmed: true });
}
