import { describe, expect, it } from 'vitest';
import { TRIAGED_ACTIONABLE, wasTriagedActionable } from './events.js';

describe('the chat route’s action ruling, as the planner reads it', () => {
  it('is recognised when the route affirmatively ruled the turn an action', () => {
    expect(wasTriagedActionable({ payload: { [TRIAGED_ACTIONABLE]: true } })).toBe(true);
  });

  it('is absent when the route reached "action" as its default rather than a ruling', () => {
    // The chat route defaults to the executor when its own triage throws. That
    // default is not evidence, so nothing is recorded and the planner asks.
    expect(wasTriagedActionable({ payload: { text: 'what do I have this week' } })).toBe(false);
  });

  it('treats every other trigger shape as no ruling, rather than throwing', () => {
    // Tasks predating this key, and every non-chat source, land here.
    expect(wasTriagedActionable({ payload: {} })).toBe(false);
    expect(wasTriagedActionable({})).toBe(false);
    expect(wasTriagedActionable(null)).toBe(false);
    expect(wasTriagedActionable(undefined)).toBe(false);
    expect(wasTriagedActionable('not an event')).toBe(false);
  });

  it('accepts only the boolean true, so a truthy stray value cannot skip the check', () => {
    expect(wasTriagedActionable({ payload: { [TRIAGED_ACTIONABLE]: 'yes' } })).toBe(false);
    expect(wasTriagedActionable({ payload: { [TRIAGED_ACTIONABLE]: 1 } })).toBe(false);
    expect(wasTriagedActionable({ payload: { [TRIAGED_ACTIONABLE]: false } })).toBe(false);
  });
});
