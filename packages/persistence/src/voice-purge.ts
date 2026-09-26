/**
 * The owner's "forget my writing voice" command: delete imported and uploaded
 * writing samples (contexts `auto:` and `upload:`), cancel the voice imports
 * still running, and drop their sources. Hand-written samples stay.
 */
export interface VoiceSamplePurgeRepository {
  readonly kind: 'voice-sample-purge-repository';
  /** Returns how many samples were deleted and the purged sources' workspace files. */
  purge(): Promise<{ deleted: number; workspacePaths: string[] }>;
}
