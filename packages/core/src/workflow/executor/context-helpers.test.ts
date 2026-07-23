import { describe, expect, it } from 'vitest';
import { isMissionSessionTask } from './context-helpers.js';

describe('isMissionSessionTask', () => {
  it('is true only when the trigger payload carries a mission id', () => {
    expect(isMissionSessionTask({ trigger: { payload: { missionId: 'm-123' } } })).toBe(true);
  });

  it('is false for a D9 known-sender-reply child (adhoc, no mission id)', () => {
    expect(
      isMissionSessionTask({ trigger: { payload: { kind: 'known_sender_reply', to: 'x@y.z' } } }),
    ).toBe(false);
  });

  it('is false when there is no payload or a non-string mission id', () => {
    expect(isMissionSessionTask({ trigger: {} })).toBe(false);
    expect(isMissionSessionTask({ trigger: null as never })).toBe(false);
    expect(isMissionSessionTask({ trigger: { payload: { missionId: 42 } } })).toBe(false);
  });
});
