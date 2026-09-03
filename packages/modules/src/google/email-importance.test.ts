import type { ModelRouter } from '@assistant/core';
import { describe, expect, it, vi } from 'vitest';
import { bulkByHeaders, fallbackImportance, scoreEmailImportance } from './email-importance.js';

const payload = (headers: Record<string, string>) => ({
  headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
});

/** A router whose `object` call resolves however the test says. */
function routerReturning(outcome: unknown): ModelRouter {
  return { object: vi.fn().mockResolvedValue(outcome) } as unknown as ModelRouter;
}

describe('bulkByHeaders', () => {
  it('recognises the standard bulk-mail headers', () => {
    expect(bulkByHeaders(payload({ Precedence: 'bulk' }))).toBe(true);
    expect(bulkByHeaders(payload({ Precedence: 'LIST' }))).toBe(true);
    expect(bulkByHeaders(payload({ 'List-Id': '<news.example.com>' }))).toBe(true);
    expect(bulkByHeaders(payload({ 'X-Campaign-Id': 'c-1' }))).toBe(true);
    expect(
      bulkByHeaders(
        payload({ 'List-Id': '<news.example.com>', 'List-Unsubscribe': '<mailto:x@y.com>' }),
      ),
    ).toBe(true);
  });

  it('does not treat ordinary mail as bulk', () => {
    expect(bulkByHeaders(payload({ From: 'anna@example.com', Subject: 'Lunch?' }))).toBe(false);
    expect(bulkByHeaders(undefined)).toBe(false);
  });

  it('does not settle a lone List-Unsubscribe, which transactional senders also set', () => {
    expect(bulkByHeaders(payload({ 'List-Unsubscribe': '<mailto:x@y.com>' }))).toBe(false);
  });
});

describe('scoreEmailImportance', () => {
  it('settles bulk mail from headers without spending a model call', async () => {
    const router = routerReturning({ ok: true, object: { importance: 5 } });
    const score = await scoreEmailImportance(router, {
      from: 'news@example.com',
      subject: 'ONE DAY ONLY',
      body: 'buy things',
      payload: payload({
        'List-Id': '<promos.example.com>',
        'List-Unsubscribe': '<mailto:u@example.com>',
      }),
      contentTrust: 'unknown',
      authenticated: true,
    });

    expect(score.importance).toBe(1);
    expect(score.category).toBe('bulk');
    expect(router.object).not.toHaveBeenCalled();
  });

  // The reported miss: a TripIt itinerary for a hotel booking carries
  // List-Unsubscribe and nothing else, and the header short-circuit scored it
  // bulk/1 with no dates before any classifier read the body — so it never
  // reached triage, the briefing, or memory extraction.
  it('scores a travel confirmation whose only bulk signal is List-Unsubscribe', async () => {
    const router = routerReturning({
      ok: true,
      object: {
        category: 'travel',
        importance: 4,
        actionable: false,
        cardCandidate: true,
        dates: [{ iso: '2026-09-05', what: 'hotel check-in' }],
        reason: 'hotel booking confirmation',
      },
    });
    const score = await scoreEmailImportance(router, {
      from: 'no-reply@tripit.com',
      subject: 'Your TripIt itinerary for Fwd: Hotels.com travel confirmation - Sat, Sep 5',
      body: 'Your itinerary is ready.',
      payload: payload({ 'List-Unsubscribe': '<mailto:u@tripit.com>' }),
      contentTrust: 'unknown',
      authenticated: true,
    });

    expect(router.object).toHaveBeenCalled();
    expect(score.category).toBe('travel');
    expect(score.importance).toBe(4);
    expect(score.dates).toHaveLength(1);
  });

  it('returns the model score for ordinary mail', async () => {
    const router = routerReturning({
      ok: true,
      object: {
        category: 'travel',
        importance: 4,
        actionable: true,
        dates: [{ iso: '2026-09-01T08:00:00Z', what: 'flight departs' }],
        reason: 'flight confirmation with a departure time',
      },
    });
    const score = await scoreEmailImportance(router, {
      from: 'bookings@airline.example',
      subject: 'Your itinerary',
      body: 'You depart 1 September at 08:00.',
      contentTrust: 'unknown',
      authenticated: true,
    });

    expect(score.importance).toBe(4);
    expect(score.category).toBe('travel');
    expect(score.dates).toHaveLength(1);
  });

  it('falls back without throwing when the model call fails', async () => {
    const router = { object: vi.fn().mockRejectedValue(new Error('provider down')) };
    const score = await scoreEmailImportance(router as unknown as ModelRouter, {
      from: 'anna@example.com',
      subject: 'Lunch?',
      body: 'Are you free Thursday?',
      contentTrust: 'known',
      authenticated: true,
    });
    // A scoring failure must never propagate: it would stall the Gmail history
    // cursor and make Pub/Sub redeliver the burst that broke it.
    expect(score.importance).toBe(3);
    expect(score.reason).toContain('could not be scored');
  });

  it('falls back when the router reports a failed outcome', async () => {
    const score = await scoreEmailImportance(routerReturning({ ok: false, reason: 'budget' }), {
      from: 'stranger@example.com',
      subject: 'hi',
      body: 'hello',
      contentTrust: 'unknown',
      authenticated: false,
    });
    expect(score.importance).toBe(2);
  });
});

describe('fallbackImportance', () => {
  it('surfaces verified known senders and stays quiet about everyone else', () => {
    // Erring toward "triage everything" would turn a model outage into a budget
    // incident; erring toward silence would swallow the owner's mail. So the
    // fallback leans on what is knowable without a model.
    expect(fallbackImportance({ contentTrust: 'known', authenticated: true }).importance).toBe(3);
    expect(fallbackImportance({ contentTrust: 'owner', authenticated: true }).importance).toBe(3);
    expect(fallbackImportance({ contentTrust: 'known', authenticated: false }).importance).toBe(2);
    expect(fallbackImportance({ contentTrust: 'unknown', authenticated: true }).importance).toBe(2);
  });
});
