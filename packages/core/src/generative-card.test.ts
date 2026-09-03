import { describe, expect, it } from 'vitest';
import {
  GenerativeCardSpecV1Schema,
  generateEvidenceCard,
  validateGroundedCard,
} from './generative-card.js';
import type { ModelRouter } from './model-router/index.js';
import type { ActionEvidence } from './workflow/response-contract.js';

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

/** Captures the corpus the compiler builds, and whether it was consulted at all. */
function stubRouter(): { router: ModelRouter; calls: string[] } {
  const calls: string[] = [];
  const router = {
    object: async (_kind: string, options: { prompt: string }) => {
      calls.push(options.prompt);
      return { ok: true as const, object: { cardable: false } };
    },
  } as unknown as ModelRouter;
  return { router, calls };
}

const hotelLookup: ActionEvidence[] = [
  {
    toolName: 'gmail.search',
    status: 'succeeded',
    args: { query: 'from:Katie hotels.com' },
    result: { results: [{ subject: 'Itinerary # 73535835545212', from: 'Katie Innes' }] },
    // The turn the owner is pointing at with "that" is always an earlier one.
    fromCurrentTask: false,
  },
];

describe('an explicitly requested card', () => {
  it('reaches the compiler even though the request carries no cardable keyword', async () => {
    const asked = stubRouter();
    await generateEvidenceCard({
      router: asked.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: hotelLookup,
      explicitRequest: true,
    });
    expect(asked.calls).toHaveLength(1);

    // Same turn without the request: no current-task evidence and no keyword, so
    // the compiler is never worth a model call.
    const unasked = stubRouter();
    await generateEvidenceCard({
      router: unasked.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: hotelLookup,
    });
    expect(unasked.calls).toHaveLength(0);
  });

  it('grounds on the prior turn the owner is pointing at', async () => {
    const asked = stubRouter();
    await generateEvidenceCard({
      router: asked.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: [...hotelLookup, { toolName: 'docs.create', status: 'succeeded', result: {} }],
      explicitRequest: true,
    });
    expect(asked.calls[0]).toContain('PRIOR_TOOL_1 gmail.search');
    expect(asked.calls[0]).toContain('73535835545212');

    // Unrequested turns keep the current-task-only corpus: a prior result must
    // not silently become groundable evidence for an unasked card.
    const ambient = stubRouter();
    await generateEvidenceCard({
      router: ambient.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: [...hotelLookup, { toolName: 'docs.create', status: 'succeeded', result: {} }],
    });
    expect(ambient.calls[0]).not.toContain('73535835545212');
  });
});
