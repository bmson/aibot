import {
  BudgetReservationError,
  enqueueTask,
  getAgent,
  getRate,
  persistMessage,
  reconcileReservation,
  releaseReservation,
  reserveCost,
  resolveApproval,
} from '@assistant/core';
import { channelBindings, conversations, type TaskRow } from '@assistant/db';
import { isAmbiguousTwilioDeliveryError, parseApprovalReply } from '@assistant/tools';
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

async function sendMeteredSms(
  deps: AgentDeps,
  input: {
    to: string;
    text: string;
    taskId?: string;
    description: string;
    critical?: boolean;
  },
): Promise<{ deliveryStatus: 'accepted' | 'unknown'; sid?: string }> {
  const rate = await getRate(deps.db, 'twilio_sms');
  const reservation = await reserveCost(deps.db, {
    source: 'twilio_sms',
    estimatedUsd: rate.unitPriceUsd,
    taskId: input.taskId,
    description: input.description,
    critical: input.critical,
  });
  if (!reservation.ok) {
    throw new BudgetReservationError(reservation.reason, reservation.resumeAt);
  }
  const reconcileAttempt = () =>
    reconcileReservation(deps.db, reservation.reservationId, {
      usd: rate.unitPriceUsd,
      quantity: 1,
      unit: rate.unit,
      unitPriceUsd: rate.unitPriceUsd,
      description: input.description,
    });
  let result: { sid: string };
  try {
    result = await deps.twilio.send(input.to, input.text);
  } catch (error) {
    if (isAmbiguousTwilioDeliveryError(error)) {
      // The provider may already have accepted and billed this message. Count
      // the attempt, then treat it as delivered so the durable final-response
      // retry loop cannot send a duplicate merely because the response was lost.
      await reconcileAttempt().catch((reconcileError) =>
        console.error('ambiguous SMS cost reconciliation failed', reconcileError),
      );
      console.error('SMS delivery outcome is unknown; automatic retry suppressed', error);
      return { deliveryStatus: 'unknown' };
    }
    await releaseReservation(deps.db, reservation.reservationId).catch(() => {});
    throw error;
  }

  // The provider side effect already happened. Never throw from metering and
  // cause a duplicate SMS; keep the hold conservative if reconciliation fails.
  await reconcileAttempt().catch((error) => console.error('SMS cost reconciliation failed', error));
  return { deliveryStatus: 'accepted', sid: result.sid };
}

/** One short, metered owner-only SMS for the deployed integration canary. */
export async function sendCanarySms(
  deps: AgentDeps,
  marker: string,
): Promise<{ deliveryStatus: 'accepted' | 'unknown'; sid?: string }> {
  if (!deps.twilio.configured() || !deps.config.OWNER_PHONE) {
    throw new Error('Twilio or OWNER_PHONE is not configured');
  }
  const text = `[aibot canary ${marker.slice(0, 8)}] SMS delivery check. No reply needed.`;
  if (text.length > 160 || /[^\x20-\x7E]/.test(text)) {
    throw new Error('canary SMS must remain one GSM-compatible segment');
  }
  return sendMeteredSms(deps, {
    to: deps.config.OWNER_PHONE,
    text,
    description: `canary SMS ${marker}`,
  });
}

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
  const isOwner = sms.from === deps.config.OWNER_PHONE;

  // SMS is a private owner channel, not a public chatbot. Fail closed before
  // touching the database so an unpaired number cannot create a conversation,
  // enqueue model work, or obtain an automated response.
  if (!isOwner) return { kind: 'ignored', reason: 'sms sender is not paired owner' };

  const agent = await getAgent(deps.db);

  const approvalReply = parseApprovalReply(sms.body);
  if (approvalReply) {
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

  const trust = 'owner' as const;
  const conversationId = await conversationForPeer(deps, agent.id, sms.from, trust);
  await persistMessage(deps.db, {
    conversationId,
    role: 'user',
    origin: 'owner',
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
  task: Pick<TaskRow, 'id' | 'conversationId' | 'trust'>,
  text: string,
): Promise<void> {
  if (task.trust !== 'owner' || !task.conversationId || !deps.twilio.configured()) return;
  const [conversation] = await deps.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, task.conversationId));
  if (conversation?.channel !== 'sms' || conversation.trust !== 'owner') return;
  const [binding] = await deps.db
    .select()
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.conversationId, task.conversationId),
        eq(channelBindings.channel, 'sms'),
      ),
    );
  if (!binding || binding.externalId !== deps.config.OWNER_PHONE) return;
  await sendMeteredSms(deps, {
    to: binding.externalId,
    text: text.slice(0, 1500),
    taskId: task.id,
    description: 'owner SMS task reply',
    critical: true,
  });
}

/** Executor hook: SMS the owner when approvals park a task. */
export async function notifyApprovalsBySms(
  deps: AgentDeps,
  approvals: Array<{ taskId: string; shortCode: string; summary: string }>,
): Promise<void> {
  if (!deps.twilio.configured() || !deps.config.OWNER_PHONE) return;
  for (const approval of approvals) {
    await sendMeteredSms(deps, {
      to: deps.config.OWNER_PHONE,
      text: `Approval ${approval.shortCode} — ${approval.summary.slice(0, 120)}. Reply YES ${approval.shortCode} or NO ${approval.shortCode} (or use the dashboard).`,
      taskId: approval.taskId,
      description: `approval notification ${approval.shortCode}`,
    });
  }
}
