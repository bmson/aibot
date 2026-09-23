/** Owner-scoped person mutations that are safe to implement per persistence provider. */
export interface ProfilePeopleCommandRepository {
  readonly kind: 'profile-people-command-repository';
  create(input: { name: string; relationship: string; aliases: string[] }): Promise<string>;
  updateRelationship(contactId: string, relationship: string): Promise<void>;
  updateIdentity(contactId: string, name: string, aliases: string[]): Promise<void>;
}

export function isProfilePeopleCommandRepository(
  value: unknown,
): value is ProfilePeopleCommandRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'profile-people-command-repository'
  );
}
