import { describe, expect, it } from 'vitest';
import {
  birthdayLabel,
  countdownPhrase,
  derivePersonGroup,
  eventDateLabel,
  formatDateKey,
  lastContactLabel,
  parseCanonicalDateKey,
  personInitials,
  relationSpanLabel,
  turningAge,
} from './people-presentation.js';

/** A fixed clock, so every expectation below is a statement about the code. */
const NOW = new Date('2026-09-02T12:00:00.000Z');

describe('birthdayLabel', () => {
  it('names the date and the age the person is turning', () => {
    // 18 March 1987, seen from September — the next birthday is ~197 days out.
    expect(
      birthdayLabel({ month: 3, day: 18, year: 1987, daysUntil: 197, turningAge: 39 }, NOW),
    ).toBe('18 March · turns 39 in 7 months');
  });

  it('drops the age clause when the birth year is unknown', () => {
    expect(
      birthdayLabel({ month: 3, day: 18, year: null, daysUntil: 197, turningAge: null }, NOW),
    ).toBe('18 March · in 7 months');
  });

  it('says "today" rather than "in 0 days"', () => {
    expect(birthdayLabel({ month: 9, day: 2, year: 1990, daysUntil: 0, turningAge: 36 }, NOW)).toBe(
      '2 September · turns 36 today',
    );
  });

  it('says "tomorrow" for the day after', () => {
    expect(birthdayLabel({ month: 9, day: 3, year: 1990, daysUntil: 1, turningAge: 36 }, NOW)).toBe(
      '3 September · turns 36 tomorrow',
    );
  });

  it('keeps the stored date for 29 February, whatever the countdown rolled to', () => {
    // nextAnnualOccurrence rolls 29 Feb to 1 March in a non-leap year. The
    // countdown may follow that; the printed date must not — the person was
    // born on the 29th.
    const label = birthdayLabel(
      { month: 2, day: 29, year: 2000, daysUntil: 180, turningAge: 27 },
      NOW,
    );
    expect(label).toContain('29 February');
    expect(label).not.toContain('March');
  });

  it('counts in days while the date is near', () => {
    expect(
      birthdayLabel({ month: 9, day: 14, year: 1980, daysUntil: 12, turningAge: 46 }, NOW),
    ).toBe('14 September · turns 46 in 12 days');
  });
});

describe('countdownPhrase', () => {
  it('rolls days up to months once counting days stops being readable', () => {
    expect(countdownPhrase(0)).toBe('today');
    expect(countdownPhrase(1)).toBe('tomorrow');
    expect(countdownPhrase(12)).toBe('in 12 days');
    expect(countdownPhrase(44)).toBe('in 44 days');
    expect(countdownPhrase(60)).toBe('in 2 months');
    expect(countdownPhrase(197)).toBe('in 7 months');
    expect(countdownPhrase(364)).toBe('in a year');
  });

  it('treats a date already past as today rather than going negative', () => {
    expect(countdownPhrase(-3)).toBe('today');
  });
});

describe('turningAge', () => {
  it('uses the year the next birthday falls in, not the current year', () => {
    // Birthday already passed this year, so the next one is in 2027.
    expect(turningAge(1987, 200, NOW)).toBe(40);
  });

  it('returns null without a birth year instead of guessing', () => {
    expect(turningAge(null, 200, NOW)).toBeNull();
  });
});

describe('parseCanonicalDateKey', () => {
  it('reads all four shapes the graph stores', () => {
    expect(parseCanonicalDateKey('2026-03-06')).toMatchObject({
      precision: 'day',
      year: 2026,
      month: 3,
      day: 6,
    });
    expect(parseCanonicalDateKey('2026-03')).toMatchObject({ precision: 'month', month: 3 });
    expect(parseCanonicalDateKey('--03-06')).toMatchObject({
      precision: 'recurring',
      year: null,
      month: 3,
      day: 6,
    });
    expect(parseCanonicalDateKey('2026')).toMatchObject({ precision: 'year', year: 2026 });
  });

  it('rejects anything that is not a key', () => {
    expect(parseCanonicalDateKey(null)).toBeNull();
    expect(parseCanonicalDateKey('')).toBeNull();
    expect(parseCanonicalDateKey('last summer')).toBeNull();
    expect(parseCanonicalDateKey('26-03-06')).toBeNull();
  });
});

describe('formatDateKey', () => {
  it('prints each precision at the precision it has', () => {
    expect(formatDateKey('2026-03-06')).toBe('6 March 2026');
    expect(formatDateKey('2026-03')).toBe('March 2026');
    expect(formatDateKey('--03-06')).toBe('6 March');
    expect(formatDateKey('2026')).toBe('2026');
    expect(formatDateKey(null)).toBe('');
  });
});

describe('relationSpanLabel', () => {
  it('states a duration when the start is fixed to a month or better', () => {
    expect(relationSpanLabel('2016-03', null, NOW)).toBe('10 years');
    expect(relationSpanLabel('2016-03-06', null, NOW)).toBe('10 years');
  });

  it('will not turn a bare year into a duration', () => {
    // "2019" could be any day of twelve months; "6 years" would be invented
    // precision that reads perfectly well and is wrong.
    expect(relationSpanLabel('2019', null, NOW)).toBe('Since 2019');
  });

  it('counts on the calendar, so an anniversary not yet reached does not round up', () => {
    // 6 December 2016 has not come round in 2026 yet: nine years, not ten.
    expect(relationSpanLabel('2016-12-06', null, NOW)).toBe('9 years');
  });

  it('uses the singular for a single year', () => {
    expect(relationSpanLabel('2025-03-06', null, NOW)).toBe('1 year');
  });

  it('falls back to the start date when less than a year has passed', () => {
    expect(relationSpanLabel('2026-03-06', null, NOW)).toBe('Since 6 March 2026');
  });

  it('shows a closed span once the relationship has ended', () => {
    expect(relationSpanLabel('2019-03-06', '2023', NOW)).toBe('2019–2023');
    expect(relationSpanLabel('2019-03-06', '2019-11', NOW)).toBe('2019');
  });

  it('handles an end with no recorded start', () => {
    expect(relationSpanLabel(null, '2023-03', NOW)).toBe('Until March 2023');
  });

  it('says nothing when the source states no span', () => {
    expect(relationSpanLabel(null, null, NOW)).toBe('');
  });

  it('says nothing for a recurring key, which names no year to anchor to', () => {
    expect(relationSpanLabel('--03-06', null, NOW)).toBe('');
  });

  it('does not report a negative duration for a start in the future', () => {
    expect(relationSpanLabel('2030-03-06', null, NOW)).toBe('From 6 March 2030');
  });
});

describe('lastContactLabel', () => {
  it('reads as a calendar day, not an elapsed-hours count', () => {
    // 23:00 yesterday is "yesterday", even though it is under 24 hours ago.
    expect(lastContactLabel(new Date('2026-09-01T23:00:00.000Z'), NOW)).toBe(
      'Last contact yesterday',
    );
    expect(lastContactLabel(new Date('2026-09-02T01:00:00.000Z'), NOW)).toBe('Last contact today');
  });

  it('scales from days to months to years', () => {
    expect(lastContactLabel(new Date('2026-08-28T12:00:00.000Z'), NOW)).toBe(
      'Last contact 5 days ago',
    );
    expect(lastContactLabel(new Date('2026-06-02T12:00:00.000Z'), NOW)).toBe(
      'Last contact 3 months ago',
    );
    expect(lastContactLabel(new Date('2024-09-02T12:00:00.000Z'), NOW)).toBe(
      'Last contact 2 years ago',
    );
  });

  it('returns null when nothing is recorded, so the caller can hide the line', () => {
    // Printing "never" would state a fact about the relationship; the truth is
    // only that the assistant has not recorded anything.
    expect(lastContactLabel(null, NOW)).toBeNull();
  });
});

describe('eventDateLabel', () => {
  it('names the day rather than an interval', () => {
    // "6m ago" on a row dated to the day claims a precision it does not have.
    expect(eventDateLabel(new Date('2026-09-02T08:00:00.000Z'), NOW)).toBe('Today');
    expect(eventDateLabel(new Date('2026-09-01T23:00:00.000Z'), NOW)).toBe('Yesterday');
  });

  it('gives an actual date once past yesterday', () => {
    expect(eventDateLabel(new Date('2026-08-02T12:00:00.000Z'), NOW)).toBe('2 August');
    expect(eventDateLabel(new Date('2026-06-20T12:00:00.000Z'), NOW)).toBe('20 June');
  });

  it('adds the year only when it differs from the current one', () => {
    expect(eventDateLabel(new Date('2025-11-14T12:00:00.000Z'), NOW)).toBe('14 November 2025');
    expect(eventDateLabel(new Date('2026-01-04T12:00:00.000Z'), NOW)).toBe('4 January');
  });

  it('handles a stated date in the future', () => {
    expect(eventDateLabel(new Date('2026-09-03T12:00:00.000Z'), NOW)).toBe('Tomorrow');
  });
});

describe('derivePersonGroup', () => {
  it("reads the owner's own words for the relationship", () => {
    expect(derivePersonGroup({ relationship: 'Sister' })).toBe('family');
    expect(derivePersonGroup({ relationship: 'my little brother' })).toBe('family');
    expect(derivePersonGroup({ relationship: 'colleague at Nord' })).toBe('work');
    expect(derivePersonGroup({ relationship: 'My manager' })).toBe('work');
    expect(derivePersonGroup({ relationship: 'friend' })).toBe('friends');
    expect(derivePersonGroup({ relationship: 'neighbour' })).toBe('friends');
    expect(derivePersonGroup({ relationship: 'Niece' })).toBe('family');
  });

  it('matches a hyphenated relationship as one word', () => {
    expect(derivePersonGroup({ relationship: 'brother-in-law' })).toBe('family');
  });

  it('matches a simple plural or verb form of a keyword', () => {
    expect(derivePersonGroup({ relationship: 'works with me at Nord' })).toBe('work');
    expect(derivePersonGroup({ relationship: 'old friends from school' })).toBe('friends');
  });

  it('does not fire on a longer word that merely contains a keyword', () => {
    // "sonar" contains "son"; "bosses" contains "boss".
    expect(derivePersonGroup({ relationship: 'sonar engineer' })).toBe('other');
    expect(derivePersonGroup({ relationship: 'bosses meeting notes' })).toBe('other');
    expect(derivePersonGroup({ relationship: 'sonnet enthusiast' })).toBe('other');
  });

  it('falls back to other rather than guessing', () => {
    expect(derivePersonGroup({ relationship: '' })).toBe('other');
    expect(derivePersonGroup({ relationship: '   ' })).toBe('other');
    expect(derivePersonGroup({ relationship: 'met at a conference' })).toBe('other');
  });
});

describe('personInitials', () => {
  it('takes the first and last name, keeping accents', () => {
    expect(personInitials('Élise Aubert')).toBe('ÉA');
    expect(personInitials('Marc')).toBe('M');
    expect(personInitials('Anna Maria Jónsdóttir')).toBe('AJ');
  });

  it('survives whitespace and an empty name', () => {
    expect(personInitials('  Léa   Aubert  ')).toBe('LA');
    expect(personInitials('')).toBe('?');
    expect(personInitials('   ')).toBe('?');
  });
});
