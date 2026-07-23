import { describe, expect, it } from 'vitest';
import { chatNoticeMessage, isApprovalProseNotice, isContractNotice } from './chat-notices.js';

describe('chat notices', () => {
  it('turns the archive race into owner-readable feedback', () => {
    expect(chatNoticeMessage('archive-active')).toBe(
      'This chat still has active work. Finish, cancel, or pause it before archiving.',
    );
    expect(chatNoticeMessage('unknown')).toBeUndefined();
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
});

describe('isApprovalProseNotice', () => {
  it('matches the executor approval list opener', () => {
    expect(
      isApprovalProseNotice(
        'This needs your approval before I act:\n\n- [A19CG] Fetch the public web page https://linear.app/careers',
      ),
    ).toBe(true);
    expect(isApprovalProseNotice('Here is the plan for your approval:')).toBe(false);
  });
});
