import { describe, expect, it } from 'vitest';
import {
  ANSWER_SOURCE_LABEL,
  answerLooksCardShaped,
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

  it('rejects a figure cut out of the middle of a range', () => {
    const sharpened = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      facts: [{ id: 'eta', label: 'Drive time', value: '1 hour', source: 'ANSWER' }],
      blocks: [{ type: 'facts', factIds: ['eta'] }],
      actions: [],
    });
    const corpus = 'ANSWER: expect the drive to take about 1 hour 15 minutes to 1 hour 30 minutes.';
    // Word for word present, and still a false claim about the estimate.
    expect(corpus).toContain('1 hour');
    expect(validateGroundedCard(sharpened, corpus)).toBeNull();

    const whole = GenerativeCardSpecV1Schema.parse({
      ...sharpened,
      facts: [
        {
          id: 'eta',
          label: 'Drive time',
          value: '1 hour 15 minutes to 1 hour 30 minutes',
          source: 'ANSWER',
        },
      ],
    });
    expect(validateGroundedCard(whole, corpus)).toEqual(whole);
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

it('creates a short hotel confirmation card directly from literal email evidence', async () => {
  const details = 'Harbor Hotel. Check-in September 5, 2026 at 4 PM. Total $105.85.';
  const router = {
    object: async () => {
      throw new Error('A model must not rewrite this short confirmation');
    },
  } as unknown as ModelRouter;
  const card = await generateEvidenceCard({
    router,
    taskId: 'test',
    sourceText: 'Create a card for my hotel reservation',
    explicitRequest: true,
    evidence: [
      {
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        result: { messages: [{ text: details }] },
      },
    ],
  });
  expect(card?.kind).toBe('generated-card');
  expect(card?.grounding).toBe('evidence');
  expect(card?.spec.facts[0]?.value).toBe(details);
  expect(card?.spec.actions).toEqual([]);
});

it('does not create a hotel card from a booking reference when the mailbox lookup found nothing', async () => {
  const router = {
    object: async () => {
      throw new Error('No source exists to compose');
    },
  } as unknown as ModelRouter;
  expect(
    await generateEvidenceCard({
      router,
      taskId: 'empty',
      sourceText: 'Create a hotel reservation card from my mailbox under QA-MISSING',
      explicitRequest: true,
      evidence: [{ toolName: 'gmail.search', status: 'succeeded', result: { results: [] } }],
    }),
  ).toBeNull();
});

const travelAnswer = `From your place in the Richmond down to Bernal Intermediate School in South San Jose is roughly 60 to 65 miles.

On a Sunday afternoon, expect the drive to take about 1 hour 15 minutes to 1 hour 30 minutes, factoring in getting through town down 19th Avenue before hopping on I-280 South.

To make the 4:15 PM arrival time without rushing, plan to head out around 2:45 PM (3:00 PM at the absolute latest).`;

describe('an answer with no tool behind it', () => {
  it('is gated on its own shape, not on a list of card words', () => {
    expect(answerLooksCardShaped(travelAnswer)).toBe(true);
    // A weather answer in prose: a temperature and labelled fields.
    expect(
      answerLooksCardShaped(
        `Here is the forecast for San Francisco today, which should hold through the evening.
- **Temperature:** 19°C
- **Conditions:** Partly cloudy
- **Wind:** 15 km/h`,
      ),
    ).toBe(true);

    // Conversation, at length, carrying one figure and nothing to lay out.
    expect(
      answerLooksCardShaped(
        'I have sent that note over to Katie, and I let her know you would follow up about the rest of it later this week once you have had a chance to think it through properly.',
      ),
    ).toBe(false);
    // A single signal is ordinary prose: "I will have it by 5pm."
    expect(
      answerLooksCardShaped(
        'I will have the draft finished and sent over to you by 5pm, once the last section is rewritten and the numbers in the appendix have been checked against the source.',
      ),
    ).toBe(false);
    // Nothing to frame.
    expect(answerLooksCardShaped('Done — sent at 4:15 PM.')).toBe(false);
  });

  it('reaches the composer with the reply as its evidence', async () => {
    const stub = stubRouter();
    await generateEvidenceCard({
      router: stub.router,
      taskId: 'task-1',
      sourceText: 'How long will it take us to get there?',
      evidence: [],
      answerText: travelAnswer,
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain('ANSWER');
    expect(stub.calls[0]).toContain('1 hour 15 minutes to 1 hour 30 minutes');
  });

  it('keeps the reply out of the corpus when the turn has tool results', async () => {
    const stub = stubRouter();
    await generateEvidenceCard({
      router: stub.router,
      taskId: 'task-1',
      sourceText: 'What is on my calendar?',
      evidence: [
        { toolName: 'calendar.list', status: 'succeeded', result: { events: [{ title: 'Game' }] } },
      ],
      answerText: travelAnswer,
    });
    // Tool rows are the better ground; prose beside them could outrank the row
    // it paraphrased.
    expect(stub.calls[0]).toContain('TOOL_1 calendar.list');
    expect(stub.calls[0]).not.toContain('ANSWER');
  });

  it('stamps the card as a view of the answer rather than a lookup', async () => {
    const router = {
      object: async () => ({
        ok: true as const,
        object: {
          cardable: true,
          card: {
            version: 1,
            title: 'Drive to Bernal Intermediate',
            icon: 'map',
            accessibilityLabel: 'Estimated drive time and departure',
            sourceLabel: 'ANSWER',
            refreshable: true,
            facts: [
              {
                id: 'eta',
                label: 'Drive time',
                value: 'about 1 hour 15 minutes to 1 hour 30 minutes',
                source: 'ANSWER',
              },
              { id: 'leave', label: 'Leave', value: 'around 2:45 PM', source: 'ANSWER' },
            ],
            blocks: [{ type: 'facts', factIds: ['eta', 'leave'] }],
            actions: [{ id: 'again', type: 'refresh', label: 'Refresh' }],
          },
        },
      }),
    } as unknown as ModelRouter;

    const card = await generateEvidenceCard({
      router,
      taskId: 'task-1',
      sourceText: 'How long will it take us to get there?',
      evidence: [],
      answerText: travelAnswer,
    });
    expect(card?.spec.sourceLabel).toBe(ANSWER_SOURCE_LABEL);
    expect(card?.spec.facts.map((fact) => fact.source)).toEqual([
      ANSWER_SOURCE_LABEL,
      ANSWER_SOURCE_LABEL,
    ]);
    // The range survives with its hedge, and there is nothing to refresh from.
    expect(card?.spec.facts[0]?.value).toBe('about 1 hour 15 minutes to 1 hour 30 minutes');
    expect(card?.spec.refreshable).toBe(false);
    expect(card?.spec.actions).toEqual([]);
    // The client reads this to know the card heads the reply, not replaces it.
    expect(card?.grounding).toBe('answer');
  });

  it('refuses a figure the answer never stated', async () => {
    const router = {
      object: async () => ({
        ok: true as const,
        object: {
          cardable: true,
          card: {
            version: 1,
            title: 'Drive to Bernal Intermediate',
            accessibilityLabel: 'Estimated drive time',
            sourceLabel: 'ANSWER',
            // The sharpened single figure the old regex produced.
            facts: [{ id: 'eta', label: 'Drive time', value: '1 hour', source: 'ANSWER' }],
            blocks: [{ type: 'facts', factIds: ['eta'] }],
          },
        },
      }),
    } as unknown as ModelRouter;
    expect(
      await generateEvidenceCard({
        router,
        taskId: 'task-1',
        sourceText: 'How long will it take us to get there?',
        evidence: [],
        answerText: travelAnswer,
      }),
    ).toBeNull();
  });
});
