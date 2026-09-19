import type { Records } from './records.js';

export type WatchRecord = Records['watches'];
export type WatchSuggestionContext = {
  watch: WatchRecord;
  fire: Records['watchFires'];
};

export interface WatchCreateInput {
  agentId: string;
  conversationId?: string | null;
  kind: 'email' | 'web';
  tier: 'notify' | 'suggest';
  name: string;
  match: unknown;
  maxFires: number | null;
  expiresAt: Date;
  nextPollAt?: Date | null;
  pollIntervalSeconds?: number | null;
  state?: unknown;
}

export interface WatchRepository {
  readonly kind: 'watch-repository';
  create(input: WatchCreateInput): Promise<WatchRecord>;
  list(agentId: string, status?: string, limit?: number): Promise<WatchRecord[]>;
  cancel(
    agentId: string,
    watchId: string,
    now: Date,
  ): Promise<{ status: string; cancelled: boolean } | null>;
  expire(agentId: string | null, now: Date): Promise<number>;
  emailCandidates(agentId: string, now: Date): Promise<WatchRecord[]>;
  claimDueWeb(now: Date, batch: number, defaultIntervalSeconds: number): Promise<WatchRecord[]>;
  updateWeb(input: {
    watchId: string;
    state: unknown;
    now: Date;
    expire?: boolean;
    expectedNextPollAt: Date;
  }): Promise<boolean>;
  recordFire(input: {
    watchId: string;
    agentId: string;
    triggerRef: string;
    summary: string;
    excerpt: string;
    now: Date;
    state?: unknown;
    expectedNextPollAt?: Date;
  }): Promise<{ recorded: boolean; watch: WatchRecord | null }>;
  getSuggestionContext(input: {
    agentId: string;
    watchId: string;
    triggerRef: string;
  }): Promise<WatchSuggestionContext | null>;
  commitSuggestion(input: {
    agentId: string;
    watchId: string;
    triggerRef: string;
    summary: string;
    proposedAction: string;
    now?: Date;
  }): Promise<{
    suggestion: Records['suggestions'];
    conversationId: string;
    fireId: string;
    watchName: string;
  } | null>;
}
