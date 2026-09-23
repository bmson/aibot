/** Read model shared by the PostgreSQL and Firestore profile voice views. */
export interface ProfileVoiceOverview {
  voiceStats: { total: number; auto: number; uploaded: number };
  voiceProfile: { description: string; dos: string[]; donts: string[]; signature: string };
  voiceImports: Array<{
    source: string;
    status: string;
    itemsTotal: number | null;
    itemsProcessed: number;
    memoriesSaved: number;
    taskId: string | null;
    error: string | null;
  }>;
}

export interface ProfileVoiceOverviewRepository {
  readonly kind: 'profile-voice-overview-repository';
  load(): Promise<ProfileVoiceOverview>;
}

export function isProfileVoiceOverviewRepository(
  value: unknown,
): value is ProfileVoiceOverviewRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'profile-voice-overview-repository' &&
    'load' in value &&
    typeof value.load === 'function'
  );
}
