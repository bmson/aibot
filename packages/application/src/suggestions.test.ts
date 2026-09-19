import type { Db } from '@assistant/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ accept: vi.fn(), dismiss: vi.fn(), snooze: vi.fn() }));
vi.mock('@assistant/core', () => ({
  acceptSuggestion: mocks.accept,
  dismissSuggestion: mocks.dismiss,
  snoozeSuggestion: mocks.snooze,
  listOpenSuggestions: vi.fn(),
  suggestionExpiresAt: (row: { expiresAt: Date }) => row.expiresAt,
}));

import { decideSuggestion, snoozeSuggestionUntil } from './suggestions.js';

const now = new Date('2026-09-19T12:00:00Z');
const tomorrow = new Date('2026-09-20T12:00:00Z');
function database(row?: Record<string, unknown>) {
  const where = vi.fn().mockResolvedValue(row ? [row] : []);
  return {
    db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) } as unknown as Db,
    where,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('suggestion decision retries', () => {
  it('returns the original task after an accepted response was lost', async () => {
    mocks.accept.mockResolvedValue({ ok: false, reason: 'This suggestion is no longer open.' });
    const { db } = database({ status: 'accepted', acceptedTaskId: 'original-task' });
    await expect(decideSuggestion(db, 'suggestion', 'accepted')).resolves.toEqual({
      ok: true,
      taskId: 'original-task',
    });
    expect(mocks.accept).toHaveBeenCalledOnce();
  });

  it('does not treat a conflicting dismissal as acceptance', async () => {
    mocks.accept.mockResolvedValue({ ok: false, reason: 'This suggestion is no longer open.' });
    const { db } = database({ status: 'dismissed', acceptedTaskId: null });
    await expect(decideSuggestion(db, 'suggestion', 'accepted')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('acknowledges a repeated dismissal but not a conflicting acceptance', async () => {
    mocks.dismiss.mockResolvedValue(false);
    await expect(
      decideSuggestion(database({ status: 'dismissed' }).db, 'suggestion', 'dismissed'),
    ).resolves.toEqual({ ok: true });
    await expect(
      decideSuggestion(database({ status: 'accepted' }).db, 'suggestion', 'dismissed'),
    ).resolves.toMatchObject({ ok: false });
  });

  it('returns the committed wake time on repeated Later taps without extending it', async () => {
    mocks.snooze.mockResolvedValue(false);
    const snoozedUntil = new Date('2026-09-20T10:00:00Z');
    const { db } = database({
      status: 'snoozed',
      snoozedUntil,
      expiresAt: new Date('2026-09-27T10:00:00Z'),
    });
    await expect(snoozeSuggestionUntil(db, 'suggestion')).resolves.toEqual({
      ok: true,
      snoozedUntil: snoozedUntil.toISOString(),
    });
  });

  it('returns a wake time for a new snooze', async () => {
    mocks.snooze.mockResolvedValue(true);
    const { db, where } = database();
    await expect(snoozeSuggestionUntil(db, 'suggestion')).resolves.toEqual({
      ok: true,
      snoozedUntil: tomorrow.toISOString(),
    });
    expect(where).not.toHaveBeenCalled();
  });

  it('does not claim an expired snooze succeeded', async () => {
    mocks.snooze.mockResolvedValue(false);
    const { db } = database({ status: 'snoozed', snoozedUntil: tomorrow, expiresAt: now });
    await expect(snoozeSuggestionUntil(db, 'suggestion')).resolves.toMatchObject({ ok: false });
  });

  it('explains when a still-open dated proposal needs an answer before tomorrow', async () => {
    mocks.snooze.mockResolvedValue(false);
    const { db } = database({ status: 'pending', expiresAt: new Date('2026-09-19T18:00:00Z') });
    await expect(snoozeSuggestionUntil(db, 'suggestion')).resolves.toEqual({
      ok: false,
      reason: 'This suggestion needs a decision sooner. Please accept or dismiss it now.',
    });
  });

  it.each([new Date('invalid'), now, new Date('2026-09-18T00:00:00Z')])(
    'rejects invalid or elapsed snooze times before persistence',
    async (until) => {
      await expect(snoozeSuggestionUntil(database().db, 'suggestion', until)).resolves.toEqual({
        ok: false,
        reason: 'Choose a future time for this suggestion.',
      });
      expect(mocks.snooze).not.toHaveBeenCalled();
    },
  );
});
