import { describe, expect, it } from 'vitest';
import {
  canonicalPredicate,
  PREDICATE_VOCABULARY,
  predicateAliases,
  predicateSpec,
} from './predicate-vocabulary.js';

/**
 * One relationship must land under one predicate however the source phrased
 * it — and canonicalization must never invent a predicate the registry does
 * not define, or quietly change what a stored edge means.
 */

describe('canonicalPredicate', () => {
  it('passes a registry id through unchanged', () => {
    expect(canonicalPredicate('works_at')).toEqual({ id: 'works_at', known: true });
  });

  it('maps a known synonym onto its registry id', () => {
    expect(canonicalPredicate('employed_by')).toEqual({ id: 'works_at', known: true });
    expect(canonicalPredicate('married_to')).toEqual({ id: 'spouse_of', known: true });
    expect(canonicalPredicate('resides_in')).toEqual({ id: 'lives_in', known: true });
  });

  it('drops a carried-over prefix from the source wording', () => {
    expect(canonicalPredicate('is_married_to')).toEqual({ id: 'spouse_of', known: true });
    expect(canonicalPredicate('is_employed_by')).toEqual({ id: 'works_at', known: true });
  });

  it('settles verb agreement rather than opening a second predicate', () => {
    expect(canonicalPredicate('work_at')).toEqual({ id: 'works_at', known: true });
    expect(canonicalPredicate('live_in')).toEqual({ id: 'lives_in', known: true });
  });

  it('normalizes spacing and case', () => {
    expect(canonicalPredicate('Employed By')).toEqual({ id: 'works_at', known: true });
    expect(canonicalPredicate('  WORKS_AT  ')).toEqual({ id: 'works_at', known: true });
  });

  it('keeps a wording it does not recognise, flagged', () => {
    // Losing a relationship the owner's own words support would be worse than
    // holding one the registry cannot type.
    expect(canonicalPredicate('advises')).toEqual({ id: 'advises', known: false });
    expect(canonicalPredicate('plays_bass_for')).toEqual({ id: 'plays_bass_for', known: false });
  });

  it('never collapses tense, because the registry treats it as meaning', () => {
    // `worked_at` is its own predicate, and the gap detector depends on the
    // difference: a past job must not answer a present-tense question.
    expect(canonicalPredicate('worked_at')).toEqual({ id: 'worked_at', known: true });
    expect(canonicalPredicate('studied_at')).toEqual({ id: 'studied_at', known: true });
  });

  it('only ever returns a registry id when it claims to know one', () => {
    const wordings = [
      'works_at',
      'employed_by',
      'is_married_to',
      'work_at',
      'headquartered_in',
      'advises',
      'plays_bass_for',
      '',
    ];
    for (const wording of wordings) {
      const result = canonicalPredicate(wording);
      if (result.known) expect(predicateSpec(result.id)).toBeDefined();
    }
  });

  it('is idempotent — canonicalizing twice changes nothing', () => {
    for (const spec of PREDICATE_VOCABULARY) {
      const once = canonicalPredicate(spec.id);
      expect(canonicalPredicate(once.id)).toEqual(once);
    }
    const mapped = canonicalPredicate('employed_by');
    expect(canonicalPredicate(mapped.id)).toEqual(mapped);
  });

  it('leaves every registry predicate exactly as it is', () => {
    // A synonym table that shadowed a real predicate would silently rewrite
    // edges that were already correct.
    for (const spec of PREDICATE_VOCABULARY) {
      expect(canonicalPredicate(spec.id)).toEqual({ id: spec.id, known: true });
    }
  });
});

describe('predicateAliases', () => {
  it('includes the id itself', () => {
    expect(predicateAliases('lives_in')).toContain('lives_in');
  });

  it('includes every wording that maps onto it', () => {
    const aliases = predicateAliases('works_at');
    expect(aliases).toContain('employed_by');
    expect(aliases).toContain('works_for');
    expect(aliases).not.toContain('worked_at');
  });

  it('every alias canonicalizes back to the id it was listed under', () => {
    for (const spec of PREDICATE_VOCABULARY) {
      for (const alias of predicateAliases(spec.id)) {
        expect(canonicalPredicate(alias).id).toBe(spec.id);
      }
    }
  });
});
