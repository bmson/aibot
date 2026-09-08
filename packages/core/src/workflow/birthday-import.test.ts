import { describe, expect, it } from 'vitest';
import { remainingBirthdaySaves, requestedBirthdaySaves } from './birthday-import.js';

describe('birthday list import', () => {
  const list =
    'Here are birthdays for family members, update their information\nBill (d) April 20, 1918 Metal Monkey\nRakel & Íris May 18, 1984 Wood Rat\nBaby sibling\t\tFire Horse';
  it('preserves supplied dates, deceased markers, shared dates and blank dates', () => {
    const result = requestedBirthdaySaves([{ role: 'user', content: list }]);
    expect(result.map((item) => item.subject)).toEqual(['Bill', 'Rakel', 'Íris']);
    expect(result[0]?.content).toContain('deceased');
    expect(result[0]?.content).toContain('April 20, 1918');
    expect(new Set(result.map((item) => item.content)).size).toBe(3);
  });
  it('resolves an explicit attach request from the owner list, never assistant guesses', () => {
    const result = requestedBirthdaySaves([
      { role: 'user', content: list },
      { role: 'assistant', content: 'Wrong Name January 1, 2000' },
      {
        role: 'user',
        content: 'Can you attach these birthdays to the people in my graph and memory',
      },
    ]);
    expect(result).toHaveLength(3);
    expect(result.some((item) => item.subject === 'Wrong Name')).toBe(false);
  });
  it('does not replay a list when the owner asks an unrelated question or a save receipt', () => {
    for (const content of [
      'Was it save to long term memory',
      'Approved',
      'Do not attach these birthdays to my memory',
      'Who has a birthday next?',
    ]) {
      expect(
        requestedBirthdaySaves([
          { role: 'user', content: list },
          { role: 'user', content },
        ]),
      ).toEqual([]);
    }
  });
  it('resumes only unsaved entries and refuses quarantined receipts', () => {
    const requested = requestedBirthdaySaves([{ role: 'user', content: list }]);
    const evidence = [
      { toolName: 'memory.save', status: 'succeeded', args: requested[0], result: { saved: true } },
    ];
    expect(remainingBirthdaySaves(requested, evidence)).toHaveLength(2);
    expect(
      remainingBirthdaySaves(
        requested,
        evidence.map((row) => ({ ...row, result: { saved: true, quarantined: true } })),
      ),
    ).toHaveLength(3);
  });
});
