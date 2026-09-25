import type { WorkspaceFileLookup } from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { files } from './schema.js';

export function createPostgresWorkspaceFileLookup(db: Db): WorkspaceFileLookup {
  return {
    kind: 'workspace-file-lookup',
    async findOwned(agentId, workspacePath) {
      const [row] = await db
        .select({ mime: files.mime })
        .from(files)
        .where(and(eq(files.agentId, agentId), eq(files.workspacePath, workspacePath)))
        .limit(1);
      return row ? { mime: row.mime } : null;
    },
  };
}
