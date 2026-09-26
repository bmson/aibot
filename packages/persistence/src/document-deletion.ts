/**
 * The owner's document deletion: the catalog record, its file inventory row,
 * its chunks, its deduplication claim, and any extraction or processing still
 * queued for it. The caller deletes the returned workspace objects.
 */
export interface DocumentDeletionRepository {
  readonly kind: 'document-deletion-repository';
  purge(
    agentId: string,
    documentId: string,
  ): Promise<{ deleted: boolean; workspacePaths: string[] }>;
}
