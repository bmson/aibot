import type { SupersedeFact } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { supersedableIds } from './supersede.js';

/**
 * The policy half of write-time supersession, tested without a database or a
 * model. What matters here is not whether the model spots a contradiction —
 * that is its job — but that a nomination it makes cannot retire a fact the
 * owner's own precedence rules say should survive.
 */

const HOUR = 3600 * 1000;
const base = new Date('2026-09-16T12:00:00Z');

function fact(over: Partial<SupersedeFact> & Pick<SupersedeFact, 'id'>): SupersedeFact {
  return {
    content: `fact ${over.id}`,
    confidence: '0.70',
    ownerConfirmed: false,
    createdAt: new Date(base.getTime() - 24 * HOUR),
    ...over,
  };
}

/** The incoming fact is always the newest — it was just written. */
const incoming = (over: Partial<SupersedeFact> = {}) =>
  fact({ id: 'new', confidence: '0.80', createdAt: base, ...over });

describe('supersedableIds', () => {
  it('retires a stale fact the new one replaces', () => {
    const old = fact({ id: 'old', content: 'lives in Oslo' });
    const next = incoming({ content: 'lives in Reykjavik' });

    expect(supersedableIds(next, [old], ['old'])).toEqual(['old']);
  });

  it('refuses to retire an owner-confirmed fact for an unconfirmed one', () => {
    // The whole point of the hand-confirm on the Profile page: a background
    // extraction cannot quietly overrule something the owner stated directly.
    const confirmed = fact({ id: 'old', ownerConfirmed: true, confidence: '0.80' });
    const next = incoming({ confidence: '0.95' });

    expect(supersedableIds(next, [confirmed], ['old'])).toEqual([]);
  });

  it('retires an owner-confirmed fact when the owner confirms a newer one', () => {
    const confirmed = fact({ id: 'old', ownerConfirmed: true, confidence: '0.90' });
    const next = incoming({ ownerConfirmed: true, confidence: '0.90' });

    expect(supersedableIds(next, [confirmed], ['old'])).toEqual(['old']);
  });

  it('keeps a confident fact when the incoming one is barely believed', () => {
    // Recency alone must not win: `pickWinner` gives the newest row a small
    // bonus, not a veto over a much better-supported fact.
    const strong = fact({ id: 'old', confidence: '0.90' });
    const next = incoming({ confidence: '0.20' });

    expect(supersedableIds(next, [strong], ['old'])).toEqual([]);
  });

  it('ignores an id that was never offered as a candidate', () => {
    const old = fact({ id: 'old' });

    expect(supersedableIds(incoming(), [old], ['some-other-fact'])).toEqual([]);
  });

  it('ignores the new fact nominating itself', () => {
    const next = incoming();

    expect(supersedableIds(next, [fact({ id: 'old' }), next], ['new'])).toEqual([]);
  });

  it('retires a repeated nomination once', () => {
    const old = fact({ id: 'old' });

    expect(supersedableIds(incoming(), [old], ['old', 'old', 'old'])).toEqual(['old']);
  });

  it('retires nothing on the common answer of an empty verdict', () => {
    const candidates = [fact({ id: 'a' }), fact({ id: 'b' })];

    expect(supersedableIds(incoming(), candidates, [])).toEqual([]);
  });

  it('retires only the nominated fact, leaving its neighbours alone', () => {
    // Candidates are everything near enough in embedding space to be worth
    // asking about; being asked about is not being replaced.
    const candidates = [
      fact({ id: 'home', content: 'lives in Oslo' }),
      fact({ id: 'work', content: 'works at Acme' }),
    ];
    const next = incoming({ content: 'lives in Reykjavik' });

    expect(supersedableIds(next, candidates, ['home'])).toEqual(['home']);
  });
});
