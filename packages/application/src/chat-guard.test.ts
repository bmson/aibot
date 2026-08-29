import { stripCueTags } from '@assistant/core/chat-cues';
import { describe, expect, it } from 'vitest';
import { guardDraft } from './chat-guard.js';

describe('guardDraft', () => {
  it('flags a tool-less draft that narrates a calendar check', () => {
    const draft =
      'I checked your primary calendar and the shared "Family" calendar — no flights in the next 3 weeks.';
    // The draft is replaced, and chat-turn both persists and streams the
    // replacement, so the reader is never left holding the unsupported text.
    expect(guardDraft(draft, [])).toMatchObject({ corrected: true });
    expect(guardDraft(draft, []).text).not.toBe(draft);
  });

  it('leaves ordinary conversation untouched', () => {
    const draft = 'Embeddings map text to vectors so similar meanings land near each other.';
    expect(guardDraft(draft, [])).toEqual({ corrected: false, text: draft });
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
    expect(guarded).toEqual({ corrected: false, text: draft });
  });

  it('flags a fresh send claim even when an earlier turn really sent one', () => {
    const guarded = guardDraft('Done — I emailed the client just now.', [
      { toolName: 'gmail.send', status: 'succeeded', result: { ok: true }, fromCurrentTask: false },
    ]);
    expect(guarded.corrected).toBe(true);
  });

  it('leaves links alone when no corpus is supplied', () => {
    // The tool ledger alone is not a corpus for this path: it holds no owner
    // turns, so every link in a turn that ran no tools would read as invented.
    const draft = 'The Next.js docs cover that: https://nextjs.org/docs/app';
    expect(guardDraft(draft, [])).toEqual({ corrected: false, text: draft });
  });

  it('keeps a link the owner themselves put in the window', () => {
    const draft = 'That page (https://example.com/pricing) lists three tiers.';
    const guarded = guardDraft(draft, [], {
      urlCorpus: 'what does https://example.com/pricing say?',
    });
    expect(guarded).toEqual({ corrected: false, text: draft });
  });

  it('still strips a link that is in no source the turn saw', () => {
    const guarded = guardDraft('Your receipt is at https://fabricated.example/r/9', [], {
      urlCorpus: 'nothing matching',
    });
    expect(guarded.corrected).toBe(true);
    expect(guarded.text).not.toContain('fabricated.example');
  });

  it('still flags a claim whose companion cue tag was stripped first', () => {
    // chat-turn strips cue tags BEFORE guarding: a tag inflating the sentence
    // could otherwise push a genuine unsupported claim past the contract's
    // bounded-gap matchers. Verify the strip-then-guard order keeps catching it.
    const draft = 'I checked [face: happy_squint] your calendar — no flights in the next 3 weeks.';
    expect(guardDraft(stripCueTags(draft).text, [])).toMatchObject({ corrected: true });
  });
});
