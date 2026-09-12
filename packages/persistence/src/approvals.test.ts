import { describe, expect, it } from 'vitest';
import { approvalIsResolved, parkedApprovalIds } from './approvals.js';

describe('parked approval checkpoint validation', () => {
  it('deduplicates explicit approval references while retaining all distinct decisions', () => {
    expect(
      parkedApprovalIds({
        pendingApprovals: [{ approvalId: 'a' }, { approvalId: 'a' }, { approvalId: 'b' }],
      }),
    ).toEqual(['a', 'b']);
  });
  it('does not silently discard malformed references and wake on only the remaining decision', () => {
    for (const invalid of [
      null,
      'a',
      {},
      { approvalId: 1 },
      { approvalId: '' },
      { approvalId: 'é'.repeat(501) },
    ])
      expect(
        parkedApprovalIds({ pendingApprovals: [{ approvalId: 'approved' }, invalid] }),
      ).toBeNull();
    expect(
      parkedApprovalIds({
        pendingApprovals: Array.from({ length: 201 }, () => ({ approvalId: 'a' })),
      }),
    ).toBeNull();
    expect(parkedApprovalIds({ pendingApprovals: [] })).toBeNull();
  });
  it('only known terminal decisions authorize recovery', () => {
    for (const status of ['approved', 'denied', 'expired'])
      expect(approvalIsResolved(status)).toBe(true);
    for (const status of ['pending', 'unknown', null, undefined])
      expect(approvalIsResolved(status)).toBe(false);
  });
});
