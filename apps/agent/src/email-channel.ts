import { getAgent } from '@assistant/core';
import type { TaskRow } from '@assistant/db';
import { conversations } from '@assistant/db';
import { buildRawEmail, type GmailPayload, gmailHeader } from '@assistant/tools';
import { eq } from 'drizzle-orm';
import type { AgentDeps } from './deps.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Executor hook: a finished email_triage task's final text goes back as an
 * email reply on the SAME Gmail thread — a request that arrives by email is
 * answered by email, not just mirrored into the dashboard.
 *
 * Owner mail only: the auto-reply recipient is exactly the owner address that
 * triggered the task (the email twin of the sms.reply_to_owner policy).
 * Mail from anyone else never auto-sends — the triage model must go through
 * gmail.create_draft / gmail.send and their approval gates.
 */
export async function deliverEmailFinal(
  deps: AgentDeps,
  task: TaskRow,
  text: string,
): Promise<boolean> {
  if (task.type !== 'email_triage' || task.trust !== 'owner') return false;
  if (!task.conversationId || !deps.googleClient.configured()) return false;

  const [conversation] = await deps.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, task.conversationId));
  if (conversation?.channel !== 'email') return false;

  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const from = typeof payload.from === 'string' ? payload.from : '';
  const subject = typeof payload.subject === 'string' ? payload.subject : '';
  if (!threadId || !from) return false;

  // RFC threading headers so the reply nests in ANY mail client (Gmail
  // threads by threadId, but Apple Mail etc. need In-Reply-To/References).
  const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
  let inReplyTo = '';
  if (messageId) {
    const original = await deps.googleClient
      .api<{ payload?: GmailPayload }>(
        `${GMAIL}/messages/${messageId}?format=metadata&metadataHeaders=Message-ID`,
      )
      .catch(() => null);
    inReplyTo = original ? gmailHeader(original.payload, 'Message-ID') : '';
  }

  const agent = await getAgent(deps.db);
  const raw = buildRawEmail({
    // explicit display name — otherwise recipients see the Google account's
    // profile name, which nothing in this stack controls
    from: `"${agent.name}" <${agent.email}>`,
    to: [from],
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`,
    body: text,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  await deps.googleClient.api(`${GMAIL}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({ raw, threadId }),
  });
  return true;
}
