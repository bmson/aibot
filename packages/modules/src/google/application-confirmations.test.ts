import { hashConfirmationToken } from '@assistant/tools';
import { describe, expect, it } from 'vitest';
import { confirmationTokenHashes } from './application-confirmations.js';

describe('confirmationTokenHashes', () => {
  it('matches a plain reference token', () => {
    const hashes = confirmationTokenHashes('Your reference is REQ-12345, thanks.');
    expect(hashes.has(hashConfirmationToken('REQ-12345'))).toBe(true);
  });

  it('recovers a token split by an invisible character or entity', () => {
    const target = hashConfirmationToken('REQ-12345');
    const softHyphen = '\u00AD';
    const zeroWidth = '\u200B';
    for (const body of [
      `reference REQ-${softHyphen}12345 confirmed`,
      `reference REQ-${zeroWidth}12345 confirmed`,
      'reference REQ-&shy;12345 confirmed',
      'reference REQ-&#8203;12345 confirmed',
    ]) {
      expect(confirmationTokenHashes(body).has(target)).toBe(true);
    }
  });

  it('does not fabricate a token from ordinary spaced words', () => {
    // Removing invisible breaks must not join visibly separate words.
    const hashes = confirmationTokenHashes('thank you for applying today');
    expect(hashes.has(hashConfirmationToken('applyingtoday'))).toBe(false);
  });
});
