/** Resolves an owner's recorded workspace file, the gate for artifact downloads. */
export interface WorkspaceFileLookup {
  readonly kind: 'workspace-file-lookup';
  /** The stored MIME type when the agent has a `files` record at this exact path. */
  findOwned(agentId: string, workspacePath: string): Promise<{ mime: string } | null>;
}
