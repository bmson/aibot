import { describe, expect, it } from 'vitest';
import { CORRECTION, guardDraft } from './chat-guard.js';

describe('guardDraft', () => {
  it('appends the correction when a tool-less draft narrates a calendar check', () => {
    const draft =
      'I checked your primary calendar and the shared "Family" calendar — no flights in the next 3 weeks.';
    const guarded = guardDraft(draft, []);
    expect(guarded.corrected).toBe(true);
    // Append, never replace: the draft already streamed to the client.
    expect(guarded.text).toBe(draft + CORRECTION);
  });

  it('leaves ordinary conversation untouched', () => {
    const draft = 'Embeddings map text to vectors so similar meanings land near each other.';
    expect(guardDraft(draft, [])).toEqual({ text: draft, corrected: false });
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
    expect(guarded).toEqual({ text: draft, corrected: false });
  });

  it('corrects a fresh send claim even when an earlier turn really sent one', () => {
    const guarded = guardDraft('Done — I emailed the client just now.', [
      { toolName: 'gmail.send', status: 'succeeded', result: { ok: true }, fromCurrentTask: false },
    ]);
    expect(guarded.corrected).toBe(true);
  });
});
