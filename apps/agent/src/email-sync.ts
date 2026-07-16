import type { Trust } from '@assistant/core';
import { enqueueTask, getAgent, persistMessage } from '@assistant/core';
import { channelBindings, contacts, conversations, gmailSyncState } from '@assistant/db';
import { extractGmailText, type GmailPayload, gmailHeader } from '@assistant/tools';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentDeps } from './deps.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const AutomatedSchema = z.object({
  automated: z
    .boolean()
    .describe('true for newsletters, notifications, receipts, no-reply senders, marketing'),
});

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

function parseSenderEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match?.[1] ?? fromHeader).trim().toLowerCase();
}

/** owner → known → (model: automated?) → unknown */
async function classifySender(
  deps: AgentDeps,
  fromEmail: string,
  subject: string,
  snippet: string,
): Promise<{ trust: Trust; automated: boolean }> {
  const rows = await deps.db.select().from(contacts);
  const contact = rows.find((c) => c.emails.some((e) => e.toLowerCase() === fromEmail));
  if (contact?.trust === 'owner') return { trust: 'owner', automated: false };
  if (contact?.trust === 'known') return { trust: 'known', automated: false };

  if (/no-?reply|notifications?@|newsletter|mailer|donotreply/i.test(fromEmail)) {
    return { trust: 'unknown', automated: true };
  }
  const triage = await deps.router.object<z.infer<typeof AutomatedSchema>>('classify', {
    schema: AutomatedSchema,
    system:
      'Classify whether this email is automated (newsletter/notification/receipt/marketing) or written by a human.',
    prompt: `From: ${fromEmail}\nSubject: ${subject}\nSnippet: ${snippet}`,
  });
  const automated = triage.ok ? triage.object.automated : false;
  return { trust: 'unknown', automated };
}

async function conversationForThread(
  deps: AgentDeps,
  agentId: string,
  threadId: string,
  trust: Trust,
  subject: string,
): Promise<string> {
  const [binding] = await deps.db
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.channel, 'email'), eq(channelBindings.externalId, threadId)));
  if (binding) return binding.conversationId;

  const [conversation] = await deps.db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust, title: subject.slice(0, 80) || '(no subject)' })
    .returning();
  if (!conversation) throw new Error('failed to create email conversation');
  await deps.db
    .insert(channelBindings)
    .values({ conversationId: conversation.id, channel: 'email', externalId: threadId })
    .onConflictDoNothing();
  return conversation.id;
}

async function processMessage(
  deps: AgentDeps,
  agentId: string,
  botEmail: string,
  messageId: string,
): Promise<'triaged' | 'skipped'> {
  const msg = await deps.googleClient.api<GmailMessage>(
    `${GMAIL}/messages/${messageId}?format=full`,
  );
  const from = parseSenderEmail(gmailHeader(msg.payload, 'From'));
  const subject = gmailHeader(msg.payload, 'Subject');

  // Never triage the bot's own outbound mail.
  if (from === botEmail.toLowerCase()) return 'skipped';
  if (!msg.labelIds?.includes('INBOX')) return 'skipped';

  const { trust, automated } = await classifySender(deps, from, subject, msg.snippet ?? '');
  if (automated) {
    console.log(`email-sync: skipping automated mail from ${from} ("${subject.slice(0, 40)}")`);
    return 'skipped';
  }

  const conversationId = await conversationForThread(deps, agentId, msg.threadId, trust, subject);
  const text = extractGmailText(msg.payload).slice(0, 20000);
  await persistMessage(deps.db, {
    conversationId,
    role: 'user',
    origin: trust === 'owner' ? 'owner' : trust === 'known' ? 'known_contact' : 'unknown',
    parts: [{ type: 'text', text }],
    text: `From: ${from}\nSubject: ${subject}\n\n${text}`,
    channelMessageId: `gmail:${msg.id}`,
  });

  const { created } = await enqueueTask(deps.db, {
    type: 'email_triage',
    event: {
      source: 'email',
      externalEventId: `gmail:${msg.id}`,
      agentId,
      conversationId,
      trust,
      payload: { threadId: msg.threadId, messageId: msg.id, from, subject },
    },
  });
  if (created) console.log(`email-sync: triage task for ${from} ("${subject.slice(0, 40)}")`);
  return 'triaged';
}

/**
 * Incremental Gmail sync. Pub/Sub pushes and the local poll both land here —
 * the notification is only a poke; history.list is the source of truth.
 * A stale/expired historyId (404) resets the baseline without triaging history.
 */
export async function syncMailbox(deps: AgentDeps): Promise<{ processed: number }> {
  if (!deps.googleClient.configured()) return { processed: 0 };
  const agent = await getAgent(deps.db);
  const botEmail = agent.email;

  const [state] = await deps.db
    .select()
    .from(gmailSyncState)
    .where(eq(gmailSyncState.mailbox, botEmail));

  const profile = await deps.googleClient.api<{ historyId: string }>(`${GMAIL}/profile`);

  if (!state?.lastHistoryId) {
    await deps.db
      .insert(gmailSyncState)
      .values({ mailbox: botEmail, lastHistoryId: BigInt(profile.historyId) })
      .onConflictDoUpdate({
        target: gmailSyncState.mailbox,
        set: { lastHistoryId: BigInt(profile.historyId), updatedAt: new Date() },
      });
    console.log(`email-sync: baseline set at historyId ${profile.historyId}`);
    return { processed: 0 };
  }

  let messageIds: string[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const url = new URL(`${GMAIL}/history`);
      url.searchParams.set('startHistoryId', String(state.lastHistoryId));
      // messageAdded: new mail. labelAdded(INBOX): mail moved into the inbox
      // later (e.g. rescued from spam) — must be triaged too.
      url.searchParams.append('historyTypes', 'messageAdded');
      url.searchParams.append('historyTypes', 'labelAdded');
      url.searchParams.set('labelId', 'INBOX');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await deps.googleClient.api<{
        history?: Array<{
          messagesAdded?: Array<{ message: { id: string } }>;
          labelsAdded?: Array<{ message: { id: string }; labelIds?: string[] }>;
        }>;
        nextPageToken?: string;
      }>(url.toString());
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) messageIds.push(added.message.id);
        for (const labeled of h.labelsAdded ?? []) {
          if (labeled.labelIds?.includes('INBOX')) messageIds.push(labeled.message.id);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      // historyId too old — reset baseline; idempotency keys make any overlap safe
      console.warn('email-sync: stale historyId, resetting baseline');
      await deps.db
        .update(gmailSyncState)
        .set({ lastHistoryId: BigInt(profile.historyId), updatedAt: new Date() })
        .where(eq(gmailSyncState.mailbox, botEmail));
      return { processed: 0 };
    }
    throw err;
  }

  messageIds = [...new Set(messageIds)];
  let processed = 0;
  for (const id of messageIds) {
    try {
      if ((await processMessage(deps, agent.id, botEmail, id)) === 'triaged') processed += 1;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) continue; // message deleted between listing and fetch
      throw err;
    }
  }

  await deps.db
    .update(gmailSyncState)
    .set({ lastHistoryId: BigInt(profile.historyId), updatedAt: new Date() })
    .where(eq(gmailSyncState.mailbox, botEmail));
  return { processed };
}

/** Renew users.watch (Gmail push). Requires GMAIL_PUBSUB_TOPIC; expires in 7 days. */
export async function renewWatch(deps: AgentDeps, topicName: string): Promise<Date> {
  const res = await deps.googleClient.api<{ historyId: string; expiration: string }>(
    `${GMAIL}/watch`,
    {
      method: 'POST',
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
    },
  );
  const agent = await getAgent(deps.db);
  const expiration = new Date(Number(res.expiration));
  await deps.db
    .insert(gmailSyncState)
    .values({ mailbox: agent.email, watchExpiration: expiration })
    .onConflictDoUpdate({
      target: gmailSyncState.mailbox,
      set: { watchExpiration: expiration, updatedAt: new Date() },
    });
  return expiration;
}
