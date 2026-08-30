import { describe, expect, it } from 'vitest';
import {
  approvalSummaryOf,
  chatNoticeMessage,
  isContractNotice,
  isDecisionProseNotice,
  noticeKindOf,
  retractionNoticeOf,
} from './chat-notices.js';

describe('chat notices', () => {
  it('turns the archive race into owner-readable feedback', () => {
    expect(chatNoticeMessage('archive-active')).toBe(
      'This chat still has active work. Finish, cancel, or pause it before archiving.',
    );
    expect(chatNoticeMessage('unknown')).toBeUndefined();
  });
});

describe('approvalSummaryOf', () => {
  it('accepts the compact purpose and action count without exposing approval payloads', () => {
    expect(
      approvalSummaryOf([
        { type: 'text', text: 'fallback copy' },
        {
          type: 'approval-summary',
          purpose: 'Find an open cafe nearby',
          approvalCount: 4,
          shortCode: 'A123',
        },
      ]),
    ).toEqual({
      type: 'approval-summary',
      purpose: 'Find an open cafe nearby',
      approvalCount: 4,
    });
  });

  it('rejects incomplete or unsafe summary parts', () => {
    expect(
      approvalSummaryOf([{ type: 'approval-summary', purpose: '', approvalCount: 1 }]),
    ).toBeNull();
    expect(
      approvalSummaryOf([{ type: 'approval-summary', purpose: 'Check plans', approvalCount: 0 }]),
    ).toBeNull();
  });

  it('carries the hydrated live state so an answered summary can settle', () => {
    expect(
      approvalSummaryOf([
        {
          type: 'approval-summary',
          purpose: 'Find an open cafe nearby',
          approvalCount: 2,
          pendingCount: 0,
          outcomes: [
            { id: 'a1', summary: 'Email the cafe', status: 'denied' },
            { id: 'a2', summary: 'Book a table', status: 'approved' },
            { id: 'a3', summary: 'ignored', status: 'not-a-status' },
            { summary: 'no id', status: 'approved' },
          ],
        },
      ]),
    ).toEqual({
      type: 'approval-summary',
      purpose: 'Find an open cafe nearby',
      approvalCount: 2,
      pendingCount: 0,
      outcomes: [
        { id: 'a1', summary: 'Email the cafe', status: 'denied' },
        { id: 'a2', summary: 'Book a table', status: 'approved' },
      ],
    });
  });
});

describe('isContractNotice', () => {
  it('matches the transparent-failure fallback (verbatim prod copy)', () => {
    expect(
      isContractNotice(
        "I can't claim that work was completed. No supporting tool action completed. " +
          'I have not created, sent, submitted, researched, or updated anything outside this ' +
          'chat for this request. I can only report an action after the required tool is ' +
          'available and returns a successful result.',
      ),
    ).toBe(true);
  });

  it('matches the partial-failure evidence ledger (verbatim prod copy)', () => {
    expect(
      isContractNotice(
        'I can verify that the requested Drive file was staged earlier in this conversation; ' +
          'the web request completed earlier in this conversation. I cannot verify the ' +
          'requested calendar action from successful tool evidence, so I am not claiming it ' +
          'completed.',
      ),
    ).toBe(true);
  });

  it('matches the simulated-approval stop', () => {
    expect(
      isContractNotice(
        'I did not create a real approval request, so nothing is waiting on the Approvals ' +
          'page. I stopped instead of showing an unverified approval code.',
      ),
    ).toBe(true);
  });

  it('does not match ordinary assistant prose that mentions verification', () => {
    expect(isContractNotice('I can verify your flight details if you forward the email.')).toBe(
      false,
    );
    expect(isContractNotice('Done — the sheet is updated.')).toBe(false);
  });

  it('matches the current transparent-failure copy', () => {
    expect(
      isContractNotice(
        "I couldn't verify this completed, so I'm not claiming it did. Nothing was sent or " +
          "changed outside this chat — say the word and I'll retry, or adjust the request.",
      ),
    ).toBe(true);
  });

  it('matches the current partial-confirmation copy', () => {
    expect(
      isContractNotice(
        "Here's what I can confirm: the Google Sheet action completed earlier in this " +
          "conversation. I can't yet confirm the requested calendar action, so I'm not claiming " +
          'that part.',
      ),
    ).toBe(true);
    expect(isContractNotice("Here's what I can confirm: your flight lands at 6pm.")).toBe(false);
  });

  it('matches the 2026-08 copy without losing the strings before it', () => {
    expect(
      isContractNotice(
        "Here's where this actually stands: I couldn't verify this completed, so I'm not " +
          'claiming it did. Nothing was sent or changed outside this chat. Say the word and ' +
          "I'll run it again, or point me at another way in.",
      ),
    ).toBe(true);
    expect(
      isContractNotice(
        "Here's what I can confirm: the Google Sheet action completed earlier in this " +
          "conversation. The rest — the requested calendar action — I can't confirm yet, so " +
          "I'm leaving it out rather than guessing.",
      ),
    ).toBe(true);
    expect(
      isContractNotice(
        "That's everything I could actually see. What I couldn't get to: a successful " +
          "all-calendar event search. I'd rather tell you that than fill it in from memory.",
      ),
    ).toBe(true);
    expect(
      isContractNotice(
        'No approval request actually exists — I never created one, so nothing is waiting on ' +
          'the Approvals page. I stopped rather than hand you a code that goes nowhere. Tell ' +
          'me to go ahead and I will raise the real one.',
      ),
    ).toBe(true);
  });
});

describe('noticeKindOf', () => {
  it('names the structured marker and ignores other parts', () => {
    expect(
      noticeKindOf([
        { type: 'text', text: 'x' },
        { type: 'notice', notice: 'response-contract' },
      ]),
    ).toBe('response-contract');
    expect(noticeKindOf([{ type: 'notice', notice: 'parked' }])).toBe('parked');
    expect(noticeKindOf([{ type: 'notice', notice: 'needs-attention' }])).toBe('needs-attention');
    expect(noticeKindOf([{ type: 'notice', notice: 'retracted' }])).toBe('retracted');
    expect(noticeKindOf([{ type: 'text', text: 'x' }, { type: 'recall' }])).toBeNull();
  });

  it('ignores a kind it does not know, so an unrecognised marker stays prose', () => {
    expect(noticeKindOf([{ type: 'notice', notice: 'something-newer' }])).toBeNull();
    expect(noticeKindOf([null, 'text', { type: 'notice' }])).toBeNull();
  });
});

describe('retractionNoticeOf', () => {
  it('preserves the original as inert disclosure data with an audit reason', () => {
    expect(
      retractionNoticeOf([
        {
          type: 'notice',
          notice: 'retracted',
          reason: 'Unsupported source data.',
          originalText: '[Fake link](https://example.invalid)',
          repairId: 'repair-v1',
        },
      ]),
    ).toEqual({
      type: 'notice',
      notice: 'retracted',
      reason: 'Unsupported source data.',
      originalText: '[Fake link](https://example.invalid)',
      repairId: 'repair-v1',
    });
  });

  it('rejects incomplete retraction markers', () => {
    expect(retractionNoticeOf([{ type: 'notice', notice: 'retracted' }])).toBeNull();
  });
});

describe('isDecisionProseNotice', () => {
  it('matches the executor approval list opener', () => {
    expect(
      isDecisionProseNotice(
        'This needs your approval before I act:\n\n- [A19CG] Fetch the public web page https://linear.app/careers',
      ),
    ).toBe(true);
    expect(isDecisionProseNotice('Here is the plan for your approval:')).toBe(false);
  });

  it('matches the runtime budget request, whose card says the same thing better', () => {
    // Verbatim opening from taskBudgetPermissionRequest in
    // packages/core/src/workflow/executor/notices.ts.
    expect(
      isDecisionProseNotice(
        'I need your permission to raise this task’s spending limit from $0.50 to $1.00 so I can finish.',
      ),
    ).toBe(true);
    expect(isDecisionProseNotice('I raised the limit as you asked.')).toBe(false);
  });
});
