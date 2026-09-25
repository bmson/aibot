/** Canonical person-name rules shared by every persistence adapter. */
export function normalizeContactName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Person name is required.');
  if (name.length > 120) throw new Error('Person name must be 120 characters or fewer.');
  if (
    [...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error('Person name contains unsupported control characters.');
  }
  return name;
}

/** Case-insensitively unique aliases, excluding the canonical name, at most 20. */
export function normalizeContactAliases(values: string[], canonicalName: string): string[] {
  const canonical = canonicalName.toLocaleLowerCase();
  const aliases = new Map<string, string>();
  for (const value of values) {
    const alias = normalizeContactName(value);
    const key = alias.toLocaleLowerCase();
    if (key !== canonical && !aliases.has(key)) aliases.set(key, alias);
  }
  if (aliases.size > 20) throw new Error('A person can have at most 20 aliases.');
  return [...aliases.values()];
}
