import { describe, expect, it } from 'vitest';
import { canonicalizeDateLabel } from './date-labels.js';

// A Wednesday, so the weekday cases have a direction to be wrong in.
const ANCHOR = new Date('2026-03-04T15:00:00Z');
const key = (raw: string, anchor = ANCHOR) =>
  canonicalizeDateLabel(raw, anchor, 'UTC', 'en-GB')?.key ?? null;

describe('canonicalizeDateLabel', () => {
  it('collapses every spelling of one date onto a single key', () => {
    for (const spelling of [
      '2026-03-06',
      '2026/3/6',
      '6 March 2026',
      '6th of March 2026',
      'March 6, 2026',
      'march 6 2026',
      'On March 6, 2026.',
    ]) {
      expect(key(spelling), spelling).toBe('2026-03-06');
    }
  });

  it('resolves relative wording against the source memory, not the clock', () => {
    expect(key('today')).toBe('2026-03-04');
    expect(key('tomorrow')).toBe('2026-03-05');
    expect(key('yesterday')).toBe('2026-03-03');
    // The Friday after Wednesday the 4th.
    expect(key('Friday')).toBe('2026-03-06');
    expect(key('this Friday')).toBe('2026-03-06');
    expect(key('next Friday')).toBe('2026-03-06');
    expect(key('last Friday')).toBe('2026-02-27');
  });

  it('never resolves a weekday into the past', () => {
    // Said on a Wednesday, "Tuesday" is the one coming, not the one gone.
    expect(key('Tuesday')).toBe('2026-03-10');
    // ...and "next Wednesday" on a Wednesday is the following one.
    expect(key('Wednesday')).toBe('2026-03-04');
    expect(key('next Wednesday')).toBe('2026-03-11');
  });

  it('keeps the anchor fixed so re-extraction lands on the same node', () => {
    const later = new Date('2027-01-01T00:00:00Z');
    expect(key('Friday', ANCHOR)).toBe(key('Friday', ANCHOR));
    expect(key('Friday', later)).not.toBe(key('Friday', ANCHOR));
  });

  it('keeps coarser precision rather than inventing a day', () => {
    expect(canonicalizeDateLabel('March 2026', ANCHOR, 'UTC', 'en-GB')).toMatchObject({
      key: '2026-03',
      precision: 'month',
    });
    expect(canonicalizeDateLabel('1998', ANCHOR, 'UTC', 'en-GB')).toMatchObject({
      key: '1998',
      precision: 'year',
    });
  });

  it('treats a bare month and day as recurring, since a birthday has no year', () => {
    const march = canonicalizeDateLabel('March 6', ANCHOR, 'UTC', 'en-GB');
    expect(march).toMatchObject({ key: '--03-06', precision: 'recurring' });
    // Its own key round-trips, so re-running the backfill is a no-op.
    expect(key(march?.key ?? '')).toBe('--03-06');
  });

  it('declines wording it cannot pin to a date', () => {
    for (const vague of [
      'soon',
      'later this quarter',
      'the weekend',
      'March',
      '31 February 2026',
      '03/04/2026',
      '',
    ]) {
      expect(key(vague), vague).toBeNull();
    }
  });

  it('anchors on the memory timezone, not UTC', () => {
    // 01:30 UTC on the 5th is still the 4th in Los Angeles.
    const lateNight = new Date('2026-03-05T01:30:00Z');
    expect(canonicalizeDateLabel('today', lateNight, 'America/Los_Angeles', 'en-GB')?.key).toBe(
      '2026-03-04',
    );
    expect(canonicalizeDateLabel('today', lateNight, 'UTC', 'en-GB')?.key).toBe('2026-03-05');
  });

  it('renders a readable label in the agent locale', () => {
    expect(canonicalizeDateLabel('2026-03-06', ANCHOR, 'UTC', 'en-GB')?.label).toBe('6 March 2026');
    expect(canonicalizeDateLabel('2026-03-06', ANCHOR, 'UTC', 'en-US')?.label).toBe(
      'March 6, 2026',
    );
  });
});
