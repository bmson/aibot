import type { SituationPackView } from './situations-schema.js';

/** One stored calendar event: what the previous read saw, to diff the next read against. */
export interface PulseCalendarSnapshot {
  calendarId: string;
  eventId: string;
  iCalUID: string | null;
  summary: string;
  start: string;
  end: string;
  status: string | null;
  attendeeResponseHash: unknown;
}

export interface PulseMail {
  channelMessageId: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  importance: number;
}

export interface PulseCommitment {
  id: string;
  title: string;
  nextAction: string;
  dueAt: Date;
}

/** The `pulse.check` job's ledger and reads. Choosing and phrasing a moment stay in core. */
export interface PulseRepository {
  readonly kind: 'pulse-repository';
  /** Moments delivered at or after `since`, for pacing. */
  deliveredSince(agentId: string, since: Date): Promise<number>;
  /** The owner's own ambient daily cap, or null when they set none. */
  ambientDailyCap(agentId: string): Promise<number | null>;
  /** Keys of every moment of this kind already delivered. */
  momentKeys(agentId: string, kind: string): Promise<string[]>;
  calendarSnapshot(agentId: string): Promise<PulseCalendarSnapshot[]>;
  /**
   * Bring the stored snapshot up to date with one successful read: drop the
   * cancelled events, upsert the events seen, and forget rows not seen since
   * `staleBefore`.
   */
  syncCalendarSnapshot(
    agentId: string,
    input: {
      cancelled: Array<{ calendarId: string; eventId: string }>;
      seen: PulseCalendarSnapshot[];
      staleBefore: Date;
      now: Date;
    },
  ): Promise<void>;
  /**
   * Actionable mail at or above `minImportance` ingested since `since` that no
   * finished task has picked up, most important first.
   */
  actionableMail(
    agentId: string,
    input: { since: Date; minImportance: number; limit: number },
  ): Promise<PulseMail[]>;
  /** Open commitments due inside `[now, until]` that are not snoozed past `now`. */
  dueCommitments(
    agentId: string,
    input: { now: Date; until: Date; limit: number },
  ): Promise<PulseCommitment[]>;
  /**
   * Claim a moment before saying it. Returns the claim's id, or null when the
   * moment was already said: exactly one of two concurrent runs wins.
   */
  claimMoment(input: {
    agentId: string;
    kind: string;
    momentKey: string;
    summary: string;
    deliveredAt: Date;
  }): Promise<string | null>;
  markPinged(agentId: string, momentId: string, pinged: boolean): Promise<void>;
  /** The owner's unarchived situation packs, with their source changes. */
  situationPacks(agentId: string): Promise<SituationPackView[]>;
}
