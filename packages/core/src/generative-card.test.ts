import { describe, expect, it } from 'vitest';
import { GenerativeCardSpecV1Schema, validateGroundedCard } from './generative-card.js';

const movieCard = {
  version: 1 as const,
  title: 'Movie ticket',
  icon: 'ticket' as const,
  accent: 'violet' as const,
  accessibilityLabel: 'Movie ticket for Dune Part Two',
  sourceLabel: 'Cinema email',
  facts: [
    { id: 'movie', label: 'Movie', value: 'Dune: Part Two', source: 'SOURCE_MESSAGE' },
    { id: 'time', label: 'Showtime', value: '7:30 PM', source: 'SOURCE_MESSAGE' },
    {
      id: 'code',
      label: 'Ticket code',
      value: 'MV-4829-AX',
      source: 'SOURCE_MESSAGE',
      sensitive: true,
    },
  ],
  blocks: [
    { type: 'hero' as const, titleFact: 'movie', subtitleFact: 'time' },
    { type: 'code' as const, valueFact: 'code', format: 'text' as const },
  ],
  actions: [{ id: 'copy', type: 'copy_value' as const, label: 'Copy code', factId: 'code' }],
  refreshable: false,
};

describe('GenerativeCardSpecV1', () => {
  it('accepts a grounded unfamiliar layout', () => {
    const parsed = GenerativeCardSpecV1Schema.parse(movieCard);
    expect(
      validateGroundedCard(
        parsed,
        'Cinema email: Dune: Part Two is booked for 7:30 PM. Ticket code MV-4829-AX.',
      ),
    ).toEqual(parsed);
  });

  it('rejects one fabricated fact even when the rest is grounded', () => {
    const parsed = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      facts: movieCard.facts.map((fact) =>
        fact.id === 'time' ? { ...fact, value: '9:30 PM' } : fact,
      ),
    });
    expect(
      validateGroundedCard(
        parsed,
        'Cinema email: Dune: Part Two is booked for 7:30 PM. Ticket code MV-4829-AX.',
      ),
    ).toBeNull();
  });

  it('rejects unsafe action URLs and missing fact bindings', () => {
    const unsafe = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      facts: [
        ...movieCard.facts,
        { id: 'url', value: 'javascript:alert(1)', source: 'SOURCE_MESSAGE' },
      ],
      actions: [{ id: 'open', type: 'open_url', label: 'Open', factId: 'url' }],
    });
    expect(validateGroundedCard(unsafe, JSON.stringify(unsafe))).toBeNull();
    const missing = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      blocks: [{ type: 'note', factId: 'not-there' }],
    });
    expect(validateGroundedCard(missing, JSON.stringify(missing))).toBeNull();
  });
});
