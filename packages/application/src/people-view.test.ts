import { describe, expect, it } from 'vitest';
import type { PersonDossier, PersonSummary } from './people.js';
import { toPersonCardView, toPersonSummaryView } from './people-view.js';

const NOW = new Date('2026-09-02T12:00:00.000Z');

function summary(overrides: Partial<PersonSummary> = {}): PersonSummary {
  return {
    id: 'c-1',
    name: 'Élise Aubert',
    relationship: 'Sister',
    trust: 'known',
    group: 'family',
    location: 'Lyon',
    factCount: 4,
    birthday: { month: 3, day: 18, year: 1987, daysUntil: 197, turningAge: 40 },
    lastContactAt: new Date('2026-09-02T09:00:00.000Z'),
    ...overrides,
  };
}

function dossier(overrides: Partial<PersonDossier> = {}): PersonDossier {
  return {
    profile: {
      contact: {
        id: 'c-1',
        name: 'Élise Aubert',
        aliases: [],
        relationship: 'Sister',
        trust: 'known',
      },
      facts: [],
      totalFacts: 4,
      occasions: [],
      occasionSuggestions: [],
      mergeOptions: [],
    } as unknown as PersonDossier['profile'],
    group: 'family',
    entityId: 'e-1',
    location: 'Lyon',
    origins: [],
    relations: [],
    connections: [],
    events: [],
    lastContactAt: null,
    birthday: null,
    upcomingOccasion: null,
    ...overrides,
  };
}

describe('toPersonSummaryView', () => {
  it('ships rendered labels rather than raw values', () => {
    const view = toPersonSummaryView(summary(), NOW);
    expect(view.birthday).toBe('18 March · turns 40 in 7 months');
    expect(view.lastContact).toBe('Last contact today');
    expect(view.groupLabel).toBe('Family');
    expect(view.initials).toBe('ÉA');
  });

  it('keeps the raw day count so a client can sort without parsing prose', () => {
    expect(toPersonSummaryView(summary(), NOW).birthdayDaysUntil).toBe(197);
  });

  it('sends null, not a placeholder, for what is not recorded', () => {
    const view = toPersonSummaryView(
      summary({ birthday: null, lastContactAt: null, location: null }),
      NOW,
    );
    expect(view.birthday).toBeNull();
    expect(view.lastContact).toBeNull();
    expect(view.location).toBeNull();
    expect(view.birthdayDaysUntil).toBeNull();
  });

  it('gives the "other" bucket no label to render', () => {
    // "Other" names a gap in what we know, not a group someone belongs to, so
    // the client must have nothing to put in a chip.
    const view = toPersonSummaryView(summary({ group: 'other', relationship: '' }), NOW);
    expect(view.group).toBe('other');
    expect(view.groupLabel).toBe('');
  });
});

describe('toPersonCardView', () => {
  it('renders a relationship span through the same rules as the web', () => {
    const view = toPersonCardView(
      dossier({
        relations: [
          {
            id: 'r-1',
            sentence: 'Élise Aubert and Marc Vidal are partners.',
            label: 'Partner',
            otherLabel: 'Marc Vidal',
            otherContactId: 'c-2',
            otherEntityId: 'e-2',
            validFrom: '2016-03',
            validUntil: null,
            reviewStatus: 'confirmed',
          },
        ],
      }),
      NOW,
    );
    expect(view.relations[0]?.span).toBe('10 years');
    expect(view.relations[0]?.otherInitials).toBe('MV');
    expect(view.relations[0]?.unreviewed).toBe(false);
  });

  it('will not turn a bare year into a duration', () => {
    const view = toPersonCardView(
      dossier({
        relations: [
          {
            id: 'r-2',
            sentence: "Élise Aubert is Léa Aubert's parent.",
            label: 'Parent',
            otherLabel: 'Léa Aubert',
            otherContactId: 'c-3',
            otherEntityId: 'e-3',
            validFrom: '2019',
            validUntil: null,
            reviewStatus: 'unreviewed',
          },
        ],
      }),
      NOW,
    );
    expect(view.relations[0]?.span).toBe('Since 2019');
    expect(view.relations[0]?.unreviewed).toBe(true);
  });

  it('dates a timeline row to the day, not to an interval', () => {
    const view = toPersonCardView(
      dossier({
        events: [
          {
            id: 'm-1',
            content: 'Lunch at Le Petit Sud.',
            occurredAt: new Date('2026-08-02T12:00:00.000Z'),
            dateIsRecordTime: false,
            kind: 'episode',
            originTrust: 'owner',
          },
        ],
      }),
      NOW,
    );
    expect(view.events[0]?.date).toBe('2 August');
    expect(view.events[0]?.dateIsRecordTime).toBe(false);
  });

  it('words the reminder from the occasion actually due', () => {
    const view = toPersonCardView(
      dossier({
        upcomingOccasion: { kind: 'birthday', label: '', daysUntil: 6, month: 9, day: 8 },
      }),
      NOW,
    );
    expect(view.reminder?.headline).toBe('Élise’s birthday is in 6 days');
    expect(view.reminder?.detail).toContain('morning brief');
  });

  it('uses the owner’s own word for a custom occasion', () => {
    const view = toPersonCardView(
      dossier({
        upcomingOccasion: { kind: 'custom', label: 'graduation', daysUntil: 1, month: 9, day: 3 },
      }),
      NOW,
    );
    expect(view.reminder?.headline).toBe('Élise’s graduation is tomorrow');
  });

  it('sends no reminder when nothing is due', () => {
    expect(toPersonCardView(dossier(), NOW).reminder).toBeNull();
  });

  it('degrades to empty for a person with nothing recorded', () => {
    const view = toPersonCardView(
      dossier({ group: 'other', location: null, birthday: null, entityId: null }),
      NOW,
    );
    expect(view.groupLabel).toBe('');
    expect(view.location).toBeNull();
    expect(view.birthday).toBeNull();
    expect(view.lastContact).toBeNull();
    expect(view.relations).toEqual([]);
    expect(view.events).toEqual([]);
    expect(view.howWeMet).toEqual([]);
    expect(view.eventsAreRecent).toBe(false);
  });
});
