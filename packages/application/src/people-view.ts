/**
 * Display-ready projections of the People reads.
 *
 * The web pages call the label functions in `people-presentation.ts` directly,
 * because a server component can. A native client cannot, and porting the
 * wording — "turns 39 in 7 months", "Since 2019", "Last contact yesterday" —
 * into Swift would mean two implementations of the same careful rules about
 * what a source is allowed to claim. They would drift, and the drift would be
 * invisible until someone compared two screens side by side.
 *
 * So the labels are computed once, here, and shipped as strings. The client
 * decides layout; the server decides what the data is allowed to say.
 */

import type { PersonDossier, PersonSummary } from './people.js';
import {
  birthdayLabel,
  countdownPhrase,
  eventDateLabel,
  lastContactLabel,
  PERSON_GROUP_LABELS,
  type PersonGroup,
  personInitials,
  relationSpanLabel,
} from './people-presentation.js';

export interface PersonSummaryView {
  id: string;
  name: string;
  initials: string;
  /** Free text the owner typed, or a stand-in the client can show as-is. */
  relationship: string;
  group: PersonGroup;
  /** '' for the 'other' bucket, which is a placement rather than a label. */
  groupLabel: string;
  trust: string;
  location: string | null;
  factCount: number;
  /** "18 March · turns 40 in 7 months", or null when no birthday is recorded. */
  birthday: string | null;
  /** Days to the next birthday, for sorting a "coming up" list client-side. */
  birthdayDaysUntil: number | null;
  /** "Last contact today", or null when nothing has been recorded. */
  lastContact: string | null;
}

export interface PersonRelationView {
  id: string;
  sentence: string;
  otherLabel: string;
  otherInitials: string;
  /** Set when the other end is a contact the client can open. */
  otherContactId: string | null;
  /** "10 years" / "Since 2019" / '' when the source states no span. */
  span: string;
  unreviewed: boolean;
}

export interface PersonConnectionView {
  id: string;
  sentence: string;
  span: string;
}

export interface PersonEventView {
  id: string;
  content: string;
  /** "Today" / "2 August" / "14 November 2025". */
  date: string;
  /** True when the date is the assistant's write time, not a stated one. */
  dateIsRecordTime: boolean;
}

export interface PersonReminderView {
  /** "Élise's birthday is in 6 days". */
  headline: string;
  detail: string;
}

export interface PersonCardView {
  id: string;
  name: string;
  initials: string;
  relationship: string;
  group: PersonGroup;
  groupLabel: string;
  trust: string;
  location: string | null;
  birthday: string | null;
  lastContact: string | null;
  /** Each origin already reads as a sentence ("Met during the conference"). */
  howWeMet: string[];
  relations: PersonRelationView[];
  connections: PersonConnectionView[];
  events: PersonEventView[];
  /** True when experience rows exist but are the rolling 90-day window. */
  eventsAreRecent: boolean;
  reminder: PersonReminderView | null;
  factCount: number;
}

function groupLabelFor(group: PersonGroup): string {
  // 'Other' names a gap in what we know, not a group someone belongs to, so
  // the client is given nothing to render rather than a misleading chip.
  return group === 'other' ? '' : PERSON_GROUP_LABELS[group];
}

export function toPersonSummaryView(person: PersonSummary, now: Date): PersonSummaryView {
  return {
    id: person.id,
    name: person.name,
    initials: personInitials(person.name),
    relationship: person.relationship,
    group: person.group,
    groupLabel: groupLabelFor(person.group),
    trust: person.trust,
    location: person.location,
    factCount: person.factCount,
    birthday: person.birthday ? birthdayLabel(person.birthday, now) : null,
    birthdayDaysUntil: person.birthday?.daysUntil ?? null,
    lastContact: lastContactLabel(person.lastContactAt, now),
  };
}

/** "birthday" / "anniversary" / the owner's own word for a custom occasion. */
function occasionNoun(kind: string, label: string): string {
  if (kind === 'custom') return label || 'occasion';
  return kind;
}

export function toPersonCardView(dossier: PersonDossier, now: Date): PersonCardView {
  const { profile } = dossier;
  const firstName = profile.contact.name.split(' ')[0] ?? profile.contact.name;

  return {
    id: profile.contact.id,
    name: profile.contact.name,
    initials: personInitials(profile.contact.name),
    relationship: profile.contact.relationship,
    group: dossier.group,
    groupLabel: groupLabelFor(dossier.group),
    trust: profile.contact.trust,
    location: dossier.location,
    birthday: dossier.birthday ? birthdayLabel(dossier.birthday, now) : null,
    lastContact: lastContactLabel(dossier.lastContactAt, now),
    howWeMet: dossier.origins.map((origin) => origin.sentence),
    relations: dossier.relations.map((relation) => ({
      id: relation.id,
      sentence: relation.sentence,
      otherLabel: relation.otherLabel,
      otherInitials: personInitials(relation.otherLabel),
      otherContactId: relation.otherContactId,
      span: relationSpanLabel(relation.validFrom, relation.validUntil, now),
      unreviewed: relation.reviewStatus === 'unreviewed',
    })),
    connections: dossier.connections.map((connection) => ({
      id: connection.id,
      sentence: connection.sentence,
      span: relationSpanLabel(connection.validFrom, connection.validUntil, now),
    })),
    events: dossier.events.map((event) => ({
      id: event.id,
      content: event.content,
      date: eventDateLabel(event.occurredAt, now),
      dateIsRecordTime: event.dateIsRecordTime,
    })),
    eventsAreRecent: dossier.events.length > 0,
    reminder: dossier.upcomingOccasion
      ? {
          headline: `${firstName}’s ${occasionNoun(
            dossier.upcomingOccasion.kind,
            dossier.upcomingOccasion.label,
          )} is ${countdownPhrase(dossier.upcomingOccasion.daysUntil)}`,
          detail: 'Reminder · the assistant will raise it in your morning brief.',
        }
      : null,
    factCount: profile.totalFacts,
  };
}
