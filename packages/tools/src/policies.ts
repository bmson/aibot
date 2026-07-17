import type { ApprovalPolicyRow, Db } from '@assistant/db';
import { approvalPolicies } from '@assistant/db';
import { and, eq } from 'drizzle-orm';
import type { ToolContext } from './types.js';

/**
 * Policy templates — the ONLY shapes an "Always allow / Never allow" rule can
 * take. Each template is code that interprets a policy row's `match` params
 * against concrete tool args. Free-form predicates are not representable by
 * construction.
 */
export type PolicyTemplate = (
  match: Record<string, unknown>,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => boolean;

export const policyTemplates: Record<string, PolicyTemplate> = {
  /** SMS replies from an owner task to the configured owner number only. */
  'sms.reply_to_owner': (match, args, ctx) => {
    const ownerPhone = String(match.phone ?? '');
    return ownerPhone.length > 0 && ctx.trust === 'owner' && args.to === ownerPhone;
  },

  /** Calendar events with no attendees — nothing leaves the assistant's world. */
  'calendar.self_only_events': (_match, args) => {
    const attendees = args.attendees as unknown[] | undefined;
    return !attendees || attendees.length === 0;
  },

  /**
   * Calendar events whose ONLY attendees are the owner's own addresses
   * (match.emails, set at seed time). Inviting the owner to something they
   * asked about is the calendar twin of replying to their SMS — the invite
   * email goes nowhere but to them.
   */
  'calendar.owner_attendee_only': (match, args) => {
    const allowed = (Array.isArray(match.emails) ? match.emails : []).map((e) =>
      String(e).toLowerCase(),
    );
    const attendees = (Array.isArray(args.attendees) ? args.attendees : []).map((a) =>
      String(a).toLowerCase(),
    );
    return (
      allowed.length > 0 && attendees.length > 0 && attendees.every((a) => allowed.includes(a))
    );
  },

  /** Email to a specific, owner-approved recipient. */
  'gmail.send.to_recipient': (match, args) => {
    const allowed = String(match.recipient ?? '').toLowerCase();
    if (!allowed) return false;
    const to = args.to;
    const recipients = (Array.isArray(to) ? to : [to]).map((r) => String(r).toLowerCase());
    return recipients.length > 0 && recipients.every((r) => r === allowed);
  },
};

export interface PolicyMatch {
  policy: ApprovalPolicyRow;
  effect: 'allow' | 'deny';
}

/** First matching enabled policy wins; deny templates are checked before allows. */
export async function matchPolicies(
  db: Db,
  input: {
    agentId: string;
    toolName: string;
    args: Record<string, unknown>;
    ctx: ToolContext;
  },
): Promise<PolicyMatch | null> {
  const rows = await db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.agentId, input.agentId),
        eq(approvalPolicies.toolName, input.toolName),
        eq(approvalPolicies.enabled, true),
      ),
    );

  const evaluate = (row: ApprovalPolicyRow): boolean => {
    const template = policyTemplates[row.templateKey];
    if (!template) return false; // unknown template = never matches (fails closed)
    return template((row.match ?? {}) as Record<string, unknown>, input.args, input.ctx);
  };

  for (const row of rows.filter((r) => r.effect === 'deny')) {
    if (evaluate(row)) return { policy: row, effect: 'deny' };
  }
  for (const row of rows.filter((r) => r.effect === 'allow')) {
    if (evaluate(row)) return { policy: row, effect: 'allow' };
  }
  return null;
}
