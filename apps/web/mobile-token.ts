import { createHash, timingSafeEqual } from 'node:crypto';

/** Compare credentials without exposing a useful length or prefix oracle. */
export function secureTokenMatches(expected: string, candidate: string): boolean {
  if (!expected || !candidate) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(candidate));
}
