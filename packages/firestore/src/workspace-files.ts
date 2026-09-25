import type { WorkspaceFileLookup } from '@assistant/persistence';
import { documentKey, type InstallationStore } from './store.js';

/** Equality on two fields, served by single-field indexes; no composite index needed. */
export class FirestoreWorkspaceFileLookup implements WorkspaceFileLookup {
  readonly kind = 'workspace-file-lookup' as const;

  constructor(readonly store: InstallationStore) {}

  async findOwned(agentId: string, workspacePath: string): Promise<{ mime: string } | null> {
    if (!agentId || !workspacePath) return null;
    const snapshot = await this.store
      .collection('files')
      .where('agentId', '==', agentId)
      .where('workspacePath', '==', workspacePath)
      .select('id', 'mime')
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    if (!doc) return null;
    const id = doc.get('id');
    if (typeof id !== 'string' || documentKey(id) !== doc.id)
      throw new Error('Workspace file record is malformed');
    const mime = doc.get('mime');
    return { mime: typeof mime === 'string' ? mime : '' };
  }
}
