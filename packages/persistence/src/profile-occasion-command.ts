/** Owner-scoped occasions, with provider-specific ownership and deduplication. */
export interface ProfileOccasionCommandInput {
  contactId: string;
  kind: 'birthday' | 'anniversary' | 'custom';
  label: string;
  month: number;
  day: number;
  year: number | null;
  leadDays: number;
  notes: string;
}

export interface ProfileOccasionCommandRepository {
  readonly kind: 'profile-occasion-command-repository';
  create(input: ProfileOccasionCommandInput): Promise<void>;
  update(
    occasionId: string,
    input: Omit<ProfileOccasionCommandInput, 'contactId'>,
    expectedContactId?: string,
  ): Promise<boolean>;
  forget(occasionId: string): Promise<void>;
  review(occasionId: string, verdict: 'approve' | 'reject'): Promise<void>;
}

export function isProfileOccasionCommandRepository(
  value: unknown,
): value is ProfileOccasionCommandRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'profile-occasion-command-repository'
  );
}
