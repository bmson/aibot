import type { Records } from './records.js';

export type CallSession = Records['callSessions'];

export interface CallTranscriptLine {
  role: 'caller' | 'assistant' | 'system';
  text: string;
  at: string;
}

export interface CallCheckin {
  id: string;
  question: string;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
  via: string | null;
}

/** Statuses in which a call still occupies the line. */
export const ACTIVE_CALL_STATUSES = ['dialing', 'ringing', 'in_progress'] as const;

export type CallSessionCreate = Omit<
  CallSession,
  | 'createdAt'
  | 'updatedAt'
  | 'twilioCallSid'
  | 'answeredBy'
  | 'startedAt'
  | 'endedAt'
  | 'durationSeconds'
  | 'transcript'
  | 'notes'
  | 'checkins'
  | 'hangupRequested'
  | 'outcome'
  | 'summary'
  | 'costUsd'
  | 'error'
>;

export type CallSessionPatch = Partial<
  Pick<
    CallSession,
    | 'status'
    | 'twilioCallSid'
    | 'reservationId'
    | 'answeredBy'
    | 'startedAt'
    | 'endedAt'
    | 'durationSeconds'
    | 'outcome'
    | 'summary'
    | 'costUsd'
    | 'error'
  >
>;

/**
 * Phone calls and their live state. The media bridge may run on a different
 * agent instance than the one that dialed, so everything the two sides share —
 * check-in answers, a hang-up request, the answering-machine verdict — travels
 * through this repository rather than process memory.
 */
export interface CallSessionRepository {
  readonly kind: 'call-session-repository';
  create(input: CallSessionCreate): Promise<CallSession>;
  get(id: string): Promise<CallSession | null>;
  getByCallSid(callSid: string): Promise<CallSession | null>;
  list(agentId: string, limit: number): Promise<CallSession[]>;
  /** Calls created since `since` (the daily cap). */
  countSince(agentId: string, since: Date): Promise<number>;
  /** Calls still dialing, ringing, or connected. */
  activeCount(agentId: string): Promise<number>;
  update(id: string, patch: CallSessionPatch): Promise<void>;
  /**
   * Redeem the one-shot media-stream token: returns the session only for the
   * first connection presenting the matching hash, clears the hash so a
   * replayed stream start is refused, and marks the call connected
   * (`in_progress`, `startedAt`).
   */
  claimStream(id: string, tokenHash: string, now: Date): Promise<CallSession | null>;
  /**
   * End a call exactly once: applies the patch only while the call is still
   * active and returns the finished row, or null when another path (the media
   * bridge or the status webhook) already finished it.
   */
  finish(id: string, patch: CallSessionPatch): Promise<CallSession | null>;
  appendTranscript(id: string, lines: readonly CallTranscriptLine[]): Promise<void>;
  appendNote(id: string, note: string): Promise<void>;
  addCheckin(id: string, checkin: CallCheckin): Promise<void>;
  /** The owner answers a check-in; false if unknown, not theirs, or already answered. */
  answerCheckin(
    agentId: string,
    id: string,
    checkinId: string,
    answer: string,
    via: string,
  ): Promise<boolean>;
  /** The owner asks to end a live call; false when no such active call. */
  requestHangup(agentId: string, id: string): Promise<boolean>;
}
