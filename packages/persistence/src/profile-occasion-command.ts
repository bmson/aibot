/** Owner-authored occasion creation, with provider-specific ownership and deduplication. */
export interface ProfileOccasionCommandRepository {
  readonly kind: 'profile-occasion-command-repository';
  create(input: {
    contactId: string;
    kind: string;
    label: string;
    month: number;
    day: number;
    year: number | null;
    leadDays: number;
    notes: string;
  }): Promise<void>;
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
