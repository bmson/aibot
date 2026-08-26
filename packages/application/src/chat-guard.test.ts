import { stripCueTags } from '@assistant/core/chat-cues';
import { describe, expect, it } from 'vitest';
import { guardDraft } from './chat-guard.js';

describe('guardDraft', () => {
  it('flags a tool-less draft that narrates a calendar check', () => {
    const draft =
      'I checked your primary calendar and the shared "Family" calendar — no flights in the next 3 weeks.';
    // The draft is marked, never edited: it already streamed to the client.
    expect(guardDraft(draft, [])).toEqual({ corrected: true });
  });

  it('leaves ordinary conversation untouched', () => {
    const draft = 'Embeddings map text to vectors so similar meanings land near each other.';
    expect(guardDraft(draft, [])).toEqual({ corrected: false });
  });

  it('keeps a truthful recap of a prior-turn artifact untouched', () => {
    const draft = 'The document I created earlier has the full itinerary.';
    const guarded = guardDraft(draft, [
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'd1' },
        fromCurrentTask: false,
      },
    ]);
    expect(guarded).toEqual({ corrected: false });
  });

  it('flags a fresh send claim even when an earlier turn really sent one', () => {
    const guarded = guardDraft('Done — I emailed the client just now.', [
      { toolName: 'gmail.send', status: 'succeeded', result: { ok: true }, fromCurrentTask: false },
    ]);
    expect(guarded.corrected).toBe(true);
  });

  it('still flags a claim whose companion cue tag was stripped first', () => {
    // chat-turn strips cue tags BEFORE guarding: a tag inflating the sentence
    // could otherwise push a genuine unsupported claim past the contract's
    // bounded-gap matchers. Verify the strip-then-guard order keeps catching it.
    const draft = 'I checked [face: happy_squint] your calendar — no flights in the next 3 weeks.';
    expect(guardDraft(stripCueTags(draft).text, [])).toEqual({ corrected: true });
  });
});
