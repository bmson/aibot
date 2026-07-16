import { enqueueTask, getAgent, persistMessage, resolveApproval } from '@assistant/core';
import { channelBindings, conversations } from '@assistant/db';
import { parseApprovalReply } from '@assistant/tools';
import { and, eq } from 'drizzle-orm';
import type { AgentDeps } from './deps.js';

export interface InboundSms {
  messageSid: string;
  from: string;
  to: string;
  body: string;
}

export type SmsHandled =
  | { kind: 'approval'; resolved: boolean; shortCode: string; decision: string }
  | { kind: 'task'; taskId: string; created: boolean }
  | { kind: 'ignored'; reason: string };

async function conversationForPeer(
  deps: AgentDeps,
  agentId: string,
  peer: string,
  trust: 'owner' | 'unknown',
): Promise<string> {
  const [binding] = await deps.db
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.channel, 'sms'), eq(channelBindings.externalId, peer)));
  if (binding) return binding.conversationId;

  const [conversation] = await deps.db
    .insert(conversations)
    .values({ agentId, channel: 'sms', trust, title: `SMS ${peer}` })
    .returning();
  if (!conversation) throw new Error('failed to create sms conversation');
  await deps.db
    .insert(channelBindings)
    .values({ conversationId: conversation.id, channel: 'sms', externalId: peer })
    .onConflictDoNothing();
  return conversation.id;
}

/**
 * Inbound SMS → approval resolution ("YES A7", owner only) or an sms_turn
 * workflow. Idempotent on MessageSid.
 */
export async function handleInboundSms(deps: AgentDeps, sms: InboundSms): Promise<SmsHandled> {
  const agent = await getAgent(deps.db);
  const isOwner = sms.from === deps.config.OWNER_PHONE;

  const approvalReply = parseApprovalReply(sms.body);
  if (approvalReply) {
    if (!isOwner) return { kind: 'ignored', reason: 'approval reply from non-owner' };
    const result = await resolveApproval(deps.db, {
      shortCode: approvalReply.shortCode,
      decision: approvalReply.decision,
      via: 'sms',
    });
    return {
      kind: 'approval',
      resolved: result.ok,
      shortCode: approvalReply.shortCode,
      decision: approvalReply.decision,
    };
  }

  const trust = isOwner ? ('owner' as const) : ('unknown' as const);
  const conversationId = await conversationForPeer(deps, agent.id, sms.from, trust);
  await persistMessage(deps.db, {
    conversationId,
    role: 'user',
    origin: isOwner ? 'owner' : 'unknown',
    parts: [{ type: 'text', text: sms.body }],
    text: sms.body,
    channelMessageId: `sms:${sms.messageSid}`,
  });

  const { task, created } = await enqueueTask(deps.db, {
    type: 'sms_turn',
    event: {
      source: 'sms',
      externalEventId: `sms:${sms.messageSid}`,
      agentId: agent.id,
      conversationId,
      trust,
      payload: { from: sms.from, body: sms.body },
    },
  });
  return { kind: 'task', taskId: task.id, created };
}

/** Executor hook: deliver a finished sms_turn's final text back to the peer. */
export async function deliverSmsFinal(
  deps: AgentDeps,
  task: { id: string; conversationId: string | null },
  text: string,
): Promise<void> {
  if (!task.conversationId || !deps.twilio.configured()) return;
  const [conversation] = await deps.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, task.conversationId));
  if (conversation?.channel !== 'sms') return;
  const [binding] = await deps.db
    .select()
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.conversationId, task.conversationId),
        eq(channelBindings.channel, 'sms'),
      ),
    );
  if (!binding) return;
  await deps.twilio.send(binding.externalId, text.slice(0, 1500));
}

/** Executor hook: SMS the owner when approvals park a task. */
export async function notifyApprovalsBySms(
  deps: AgentDeps,
  approvals: Array<{ shortCode: string; summary: string }>,
): Promise<void> {
  if (!deps.twilio.configured() || !deps.config.OWNER_PHONE) return;
  for (const approval of approvals) {
    await deps.twilio.send(
      deps.config.OWNER_PHONE,
      `Approval ${approval.shortCode} — ${approval.summary.slice(0, 120)}. Reply YES ${approval.shortCode} or NO ${approval.shortCode} (or use the dashboard).`,
    );
  }
}
