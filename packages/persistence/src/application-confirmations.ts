import type { Records } from './records.js';

export type ApplicationConfirmationRecord = Records['applicationConfirmations'];

export interface CreateApplicationWatchInput {
  agentId: string;
  sourceTaskId: string;
  /** The follow-up chat; when null a new owner chat titled `newConversationTitle` is created. */
  conversationId: string | null;
  newConversationTitle: string;
  company: string;
  role: string;
  expectedSenderEmails: string[];
  confirmationTokenHash: string;
  confirmationTokenHint: string;
  trackerUpdate: unknown;
  documentUpdate: unknown;
  actionState: unknown;
  expiresAt: Date;
}

/**
 * Owner-approved application confirmation watches (the `applications.*`
 * tools and the email match that completes them). Every status transition is
 * guarded on the status it leaves, so a replayed email or a racing cancel
 * changes a record at most once.
 */
export interface ApplicationConfirmationRepository {
  readonly kind: 'application-confirmation-repository';
  /**
   * Create a watch, refusing when an active watch already uses the token.
   * Throws 'an active confirmation watch already uses this token'.
   */
  createWatch(input: CreateApplicationWatchInput): Promise<ApplicationConfirmationRecord>;
  /** The owner's 100 newest watches, optionally of one status. */
  list(agentId: string, status?: string): Promise<ApplicationConfirmationRecord[]>;
  /** Cancel a watch still awaiting its email; otherwise report its current status. */
  cancel(
    agentId: string,
    id: string,
    now: Date,
  ): Promise<{ id: string; status: string; cancelled: boolean } | null>;
  get(id: string): Promise<ApplicationConfirmationRecord | null>;
  /**
   * Replace the per-action state. With `requireStatus`, only while the record
   * still has that status; returns the updated record or null.
   */
  updateActionState(
    id: string,
    input: {
      actionState: unknown;
      lastError?: string | null;
      status?: string;
      requireStatus?: string;
      now: Date;
    },
  ): Promise<ApplicationConfirmationRecord | null>;
  /** Expire watches still awaiting an email past `expiresAt`; returns the rows it moved. */
  expireDue(now: Date, agentId?: string): Promise<ApplicationConfirmationRecord[]>;
  byConfirmationMessage(
    agentId: string,
    confirmationMessageId: string,
  ): Promise<ApplicationConfirmationRecord | null>;
  /** Watches awaiting an email from `from` that have not expired. */
  awaitingFrom(agentId: string, from: string, now: Date): Promise<ApplicationConfirmationRecord[]>;
  /** Claim a watch for one email, only while it is still awaiting and unexpired. */
  claim(
    id: string,
    input: { confirmationMessageId: string; confirmationFrom: string; now: Date },
  ): Promise<ApplicationConfirmationRecord | null>;
  /** The status of the tool call holding an idempotency key, if any. */
  toolCallStatus(idempotencyKey: string): Promise<string | null>;
  /**
   * Settle a still-executing tool call whose side effect the record already
   * shows as succeeded, so the ledger never keeps a phantom in-flight call.
   */
  settleExecutingToolCall(
    taskId: string,
    toolName: string,
    result: unknown,
    now: Date,
  ): Promise<void>;
}
