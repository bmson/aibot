import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CompanionState,
  getCompanionState,
  resetCompanionState,
  setCompanionState,
  subscribeCompanion,
} from './companion-bus';

beforeEach(() => {
  resetCompanionState();
});

describe('companion bus', () => {
  it('replays the current state to a new subscriber', () => {
    setCompanionState({ thought: { label: 'Searching email', tone: 'working' } });
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.thought?.label).toBe('Searching email');
  });

  it('notifies subscribers on a real change', () => {
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ activity: 'working' });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.activity).toBe('working');
  });

  it('stops notifying after unsubscribe', () => {
    const seen: CompanionState[] = [];
    const off = subscribeCompanion((state) => seen.push(state));
    off();
    setCompanionState({ activity: 'thinking' });
    expect(seen).toHaveLength(1);
    expect(getCompanionState().activity).toBe('thinking');
  });

  it('keeps the chat activity and the shell presence independent', () => {
    setCompanionState({ activity: 'speaking' });
    setCompanionState({ presence: 'attention' });
    expect(getCompanionState()).toMatchObject({ activity: 'speaking', presence: 'attention' });
  });
});

describe('no-op patches', () => {
  it('drops a patch that changes nothing, so the island never restarts', () => {
    setCompanionState({ activity: 'thinking' });
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ activity: 'thinking' });
    setCompanionState({});
    expect(seen).toHaveLength(1);
  });

  it('compares thoughts by value, not by reference', () => {
    // The chat rebuilds this object on every render. Comparing by identity
    // would republish on each keystroke and restart the island's animation.
    setCompanionState({ thought: { label: 'Searching email', tone: 'working' } });
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ thought: { label: 'Searching email', tone: 'working' } });
    expect(seen).toHaveLength(1);
  });

  it('publishes when only the tone changes', () => {
    // The same step failing is the whole point of the island — a label-only
    // comparison would show it as still working.
    setCompanionState({ thought: { label: 'Searching email', tone: 'working' } });
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ thought: { label: 'Searching email', tone: 'failed' } });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.thought?.tone).toBe('failed');
  });

  it('treats clearing the thought as a change', () => {
    setCompanionState({ thought: { label: 'Thinking', tone: 'thinking' } });
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ thought: null });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.thought).toBeNull();
  });

  it('stays quiet when a null thought is republished', () => {
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ thought: null });
    expect(seen).toHaveLength(1);
  });
});
