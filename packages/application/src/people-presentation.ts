/**
 * Display derivation for the People section.
 *
 * Deliberately data-only — no database, no config — so every label the owner
 * reads on a person card is a pure function of stored values and a clock, and
 * can be tested without a fixture. The companion module
 * `relationship-presentation.ts` turns one graph edge into a sentence; this one
 * turns dates, spans, and a free-text relationship into the surrounding labels.
 *
 * The governing rule is that a label never claims more precision than its
 * source. A relationship whose start is recorded as the bare year `2019` gets
 * "Since 2019", never "6 years" — the source never said which day.
 */

/** Coarse buckets the directory groups by. Not stored; derived on read. */
export type PersonGroup = 'family' | 'work' | 'friends' | 'other';

export const PERSON_GROUPS: readonly PersonGroup[] = ['family', 'work', 'friends', 'other'];

export const PERSON_GROUP_LABELS: Record<PersonGroup, string> = {
  family: 'Family',
  work: 'Work',
  friends: 'Friends',
  other: 'Other',
};

/** A birthday occasion reduced to what the card needs. */
export interface BirthdayView {
  month: number;
  day: number;
  /** Frequently unknown — the schema makes the birth year optional. */
  year: number | null;
  /** Whole days until the next occurrence, from `daysUntilOccurrence`. */
  daysUntil: number;
  /** The age reached on that next occurrence; null when the year is unknown. */
  turningAge: number | null;
}

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAY = 86_400_000;

/**
 * The age someone reaches on the next occurrence of their birthday. Returns
 * null without a birth year rather than guessing one.
 *
 * `nextOccurrenceYear` is the calendar year the upcoming birthday falls in,
 * which is this year or next depending on whether the date has passed —
 * computing it from the day count keeps this function in step with
 * `nextAnnualOccurrence` instead of re-deriving the roll-over rule.
 */
export function turningAge(birthYear: number | null, daysUntil: number, now: Date): number | null {
  if (birthYear === null) return null;
  const next = new Date(now.getTime() + daysUntil * DAY);
  return next.getUTCFullYear() - birthYear;
}

/**
 * "18 March · turns 39 in 7 months" — the date, then when it next comes round.
 * Without a birth year the age clause is dropped rather than faked.
 */
export function birthdayLabel(birthday: BirthdayView, _now: Date): string {
  const month = MONTHS_LONG[birthday.month - 1] ?? String(birthday.month);
  const date = `${birthday.day} ${month}`;
  const when = countdownPhrase(birthday.daysUntil);
  if (birthday.turningAge === null) return when ? `${date} · ${when}` : date;
  const age =
    birthday.daysUntil === 0
      ? `turns ${birthday.turningAge} today`
      : `turns ${birthday.turningAge} ${when}`;
  return `${date} · ${age}`;
}

/**
 * "today" / "tomorrow" / "in 12 days" / "in 7 months".
 *
 * Days stop reading as a quantity somewhere around six weeks — "in 213 days" is
 * a number you have to divide before it means anything — so the scale rolls up
 * to months, matching how `relativeTime` handles the same problem.
 */
export function countdownPhrase(daysUntil: number): string {
  if (daysUntil <= 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  if (daysUntil < 45) return `in ${daysUntil} days`;
  const months = Math.round(daysUntil / 30);
  if (months < 12) return `in ${months} months`;
  return 'in a year';
}

/**
 * Canonical date keys as the knowledge graph stores them: a full day
 * (`2026-03-06`), a month (`2026-03`), a bare year (`2026`), or a recurring
 * month-day with no year at all (`--03-06`). Anything else is not a key.
 */
export interface ParsedDateKey {
  precision: 'day' | 'month' | 'year' | 'recurring';
  year: number | null;
  month: number | null;
  day: number | null;
}

export function parseCanonicalDateKey(key: string | null): ParsedDateKey | null {
  if (!key) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (day) {
    return {
      precision: 'day',
      year: Number(day[1]),
      month: Number(day[2]),
      day: Number(day[3]),
    };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month) {
    return { precision: 'month', year: Number(month[1]), month: Number(month[2]), day: null };
  }
  const recurring = /^--(\d{2})-(\d{2})$/.exec(key);
  if (recurring) {
    return {
      precision: 'recurring',
      year: null,
      month: Number(recurring[1]),
      day: Number(recurring[2]),
    };
  }
  const year = /^(\d{4})$/.exec(key);
  if (year) return { precision: 'year', year: Number(year[1]), month: null, day: null };
  return null;
}

/** Human wording for one canonical key: "6 March 2026", "March 2026", "2026", "6 March". */
export function formatDateKey(key: string | null): string {
  const parsed = parseCanonicalDateKey(key);
  if (!parsed) return '';
  const month = parsed.month === null ? '' : (MONTHS_LONG[parsed.month - 1] ?? '');
  if (parsed.precision === 'day') return `${parsed.day} ${month} ${parsed.year}`;
  if (parsed.precision === 'month') return `${month} ${parsed.year}`;
  if (parsed.precision === 'recurring') return `${parsed.day} ${month}`;
  return String(parsed.year);
}

/**
 * How long a relationship has stood: "10 years" when the source gives a real
 * start date, "Since 2019" when it only gives a year, "2019–2023" once it has
 * ended, and '' when the source states no span.
 *
 * A duration is only ever computed from day precision. Turning the key `2019`
 * into "6 years" would invent up to twelve months of certainty the source
 * never had — and it is the kind of error nobody catches, because it reads
 * perfectly well.
 */
export function relationSpanLabel(
  validFrom: string | null,
  validUntil: string | null,
  now: Date,
): string {
  const from = parseCanonicalDateKey(validFrom);
  const until = parseCanonicalDateKey(validUntil);

  if (from && until) {
    const start = from.precision === 'recurring' ? '' : String(from.year);
    const end = until.precision === 'recurring' ? '' : String(until.year);
    if (start && end) return start === end ? start : `${start}–${end}`;
    return formatDateKey(validUntil) ? `Until ${formatDateKey(validUntil)}` : '';
  }

  if (!from) {
    return until ? `Until ${formatDateKey(validUntil)}` : '';
  }

  // A recurring month-day names no year, so it can anchor nothing.
  if (from.precision === 'recurring') return '';

  // Day and month precision both fix the start to within a month, which a
  // whole-year duration can absorb. A bare year cannot: "2019" could be any
  // day of twelve, so it stays "Since 2019" rather than becoming "6 years".
  if ((from.precision === 'day' || from.precision === 'month') && from.year !== null) {
    const started = Date.UTC(from.year, (from.month ?? 1) - 1, from.day ?? 1);
    const years = completedYears(started, now);
    if (years < 0) return `From ${formatDateKey(validFrom)}`;
    if (years === 0) return `Since ${formatDateKey(validFrom)}`;
    return `${years} year${years === 1 ? '' : 's'}`;
  }

  return `Since ${formatDateKey(validFrom)}`;
}

/** Whole years elapsed, counted on the calendar rather than by dividing days. */
function completedYears(startedUtcMs: number, now: Date): number {
  const start = new Date(startedUtcMs);
  let years = now.getUTCFullYear() - start.getUTCFullYear();
  const anniversary = Date.UTC(now.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (today < anniversary) years -= 1;
  return years;
}

/**
 * "Last contact today" / "Last contact 3 days ago". Null when nothing is
 * recorded — the caller hides the line rather than printing "never", which
 * would read as a fact about the relationship instead of a gap in the record.
 *
 * "Contact" rather than "spoke" because the underlying experience memory does
 * not record a channel: it may have been a lunch, a call, or an email, and the
 * label must not pick one.
 */
export function lastContactLabel(at: Date | null, now: Date): string | null {
  if (!at) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const then = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const days = Math.round((today - then) / DAY);
  if (days <= 0) return 'Last contact today';
  if (days === 1) return 'Last contact yesterday';
  if (days < 30) return `Last contact ${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `Last contact ${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365);
  return `Last contact ${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * The date on a timeline row: "Today", "Yesterday", "2 August", "2 August 2024".
 *
 * Deliberately not `relativeTime`. These rows are dated to the day — often
 * from a stated date rather than a write time — so rendering "6m ago" claims a
 * precision the row does not have, and "1mo ago" is worse than the date it is
 * hiding. A reader scanning a history wants to know *when*, and past a couple
 * of days an actual date answers that better than an interval.
 */
export function eventDateLabel(at: Date, now: Date): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const then = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const days = Math.round((today - then) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days === -1) return 'Tomorrow';
  const month = MONTHS_LONG[at.getUTCMonth()] ?? '';
  const date = `${at.getUTCDate()} ${month}`;
  return at.getUTCFullYear() === now.getUTCFullYear() ? date : `${date} ${at.getUTCFullYear()}`;
}

/**
 * Keyword table for the free-text `contacts.relationship` column. It is owner-
 * written prose ("my little sister", "colleague at Nord"), so matching is on
 * word boundaries over a lowercased string rather than equality.
 */
const GROUP_KEYWORDS: ReadonlyArray<readonly [PersonGroup, readonly string[]]> = [
  [
    'family',
    [
      'mother',
      'mum',
      'mom',
      'father',
      'dad',
      'parent',
      'sister',
      'brother',
      'sibling',
      'son',
      'daughter',
      'child',
      'kid',
      'wife',
      'husband',
      'spouse',
      'partner',
      'grandmother',
      'grandma',
      'grandfather',
      'grandpa',
      'grandparent',
      'grandson',
      'granddaughter',
      'grandchild',
      'aunt',
      'uncle',
      'niece',
      'nephew',
      'cousin',
      'in-law',
      'family',
      'fiancé',
      'fiancée',
      'fiance',
      'fiancee',
    ],
  ],
  [
    'work',
    [
      'colleague',
      'coworker',
      'co-worker',
      'manager',
      'boss',
      'report',
      'client',
      'customer',
      'employer',
      'employee',
      'teammate',
      'team',
      'founder',
      'investor',
      'contractor',
      'supplier',
      'vendor',
      'advisor',
      'mentor',
      'work',
    ],
  ],
  ['friends', ['friend', 'neighbour', 'neighbor', 'flatmate', 'roommate', 'housemate']],
];

/**
 * Which bucket a person belongs in.
 *
 * Derived from `contacts.relationship` alone, because that column is the
 * owner's own statement of how they know this person. The knowledge graph
 * looks like a better source and is not: its edges connect a person to *third
 * parties* — Tomás `worked_at` a studio, Élise is `partner_of` Marc — and none
 * of that says anything about their relationship to the owner. Bucketing a
 * friend under Work because he has ever held a job is exactly the kind of
 * confident wrong answer this section should not produce.
 *
 * Falls through to 'other', which is a real answer ("not placed yet"), not a
 * failure.
 */
export function derivePersonGroup(input: { relationship: string }): PersonGroup {
  const text = input.relationship.toLocaleLowerCase();
  if (!text.trim()) return 'other';
  for (const [group, keywords] of GROUP_KEYWORDS) {
    if (keywords.some((keyword) => containsWord(text, keyword))) return group;
  }
  return 'other';
}

/**
 * Word-boundary containment, with a trailing "s" allowed so one entry covers
 * both "work" and "works" (the relationship column is prose — "works with me
 * at Nord" is as common as "colleague"). The boundary is what keeps this from
 * over-matching: "son" does not fire on "sonar", and "boss" does not fire on
 * "bosses".
 *
 * A hyphen counts as a word character, so "in-law" matches inside
 * "brother-in-law" while a bare "law" would not.
 */
function containsWord(haystack: string, needle: string): boolean {
  const isWordChar = (character: string | undefined) =>
    character !== undefined && /[a-z0-9à-ÿ]/.test(character);
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (!isWordChar(haystack[index - 1])) {
      const after = haystack[index + needle.length];
      if (!isWordChar(after)) return true;
      // Accept a simple plural or third-person form, but nothing longer.
      if (after === 's' && !isWordChar(haystack[index + needle.length + 1])) return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/** Up to two initials for the avatar disc, honouring combining marks ("ÉA"). */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...(words[0] ?? '')][0] ?? '';
  const last = words.length > 1 ? ([...(words[words.length - 1] ?? '')][0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase();
}
