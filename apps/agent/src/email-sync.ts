import type { Trust } from '@assistant/core';
import {
  captureOwnerWritingSample,
  enqueueTask,
  getAgent,
  persistMessage,
  quotesExternalContent,
} from '@assistant/core';
import {
  channelBindings,
  contacts,
  conversations,
  gmailSyncState,
  messages as storedMessages,
  tasks,
} from '@assistant/db';
import { extractGmailText, type GmailPayload, gmailHeader } from '@assistant/tools';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { processApplicationConfirmation } from './application-confirmations.js';
import type { AgentDeps } from './deps.js';
import { notifyOwnerBySms } from './sms-channel.js';
import { matchEmailWatches } from './watches.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HISTORY_PAGE_SIZE = 25;
const MAX_MESSAGES_PER_SYNC = 10;
const MAX_PAGES_PER_SYNC = 2;
const MAX_SYNC_WALL_MS = 90_000;
const MESSAGE_FETCH_TIMEOUT_MS = 30_000;
const CLASSIFY_TIMEOUT_MS = 20_000;

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

export interface MailboxSyncResult {
  processed: number;
  /** A durable cursor remains; the scheduler or next push should continue it. */
  morePending?: boolean;
}

const GmailPendingPageSchema = z.object({
  messageIds: z.array(z.string().min(1).max(256)).max(20_000),
  index: z.number().int().nonnegative(),
  nextPageToken: z.string().max(4096).optional(),
});
const GmailCursorPageFields = {
  targetHistoryId: z.string().regex(/^\d+$/),
  pageToken: z.string().max(4096).optional(),
  pending: GmailPendingPageSchema.optional(),
};
const GmailDrainCursorSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('history'),
      startHistoryId: z.string().regex(/^\d+$/),
      ...GmailCursorPageFields,
    })
    .strict(),
  z.object({ mode: z.literal('inbox'), ...GmailCursorPageFields }).strict(),
]);
type GmailDrainCursor = z.infer<typeof GmailDrainCursorSchema>;

/**
 * Coalesce concurrent sync pokes without losing one that arrived mid-flight.
 * Every caller awaits the same drain; a dirty notification forces one more
 * pass after the active pass reaches its durable history checkpoint.
 */
export class MailboxSyncCoordinator {
  private running: Promise<MailboxSyncResult> | undefined;
  private dirty = false;

  constructor(private readonly runOnce: () => Promise<MailboxSyncResult>) {}

  sync(): Promise<MailboxSyncResult> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drain(): Promise<MailboxSyncResult> {
    let processed = 0;
    let morePending = false;
    do {
      this.dirty = false;
      const result = await this.runOnce();
      processed += result.processed;
      morePending = result.morePending === true;
    } while (this.dirty);
    return morePending ? { processed, morePending: true } : { processed };
  }
}

function parseSenderEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match?.[1] ?? fromHeader).trim().toLowerCase();
}

function normalizedAuthDomain(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^[@<"']+|[>"'),]+$/g, '')
    .toLowerCase();
  return (cleaned.includes('@') ? cleaned.split('@').pop() : cleaned) ?? '';
}

/**
 * Alignment between the From domain and the domain a pass clause authenticated.
 * DMARC is always strict (its header.from IS the alignment result). DKIM/SPF
 * additionally allow relaxed organizational alignment, but ONLY as a genuine
 * subdomain relationship on a dot boundary (mail.example.com ~ example.com), so
 * two different orgs under a shared public suffix never align (a.co.uk is not a
 * subdomain of b.co.uk) and nothing aligns to a bare TLD. This is conservative
 * on purpose: DKIM/SPF pass semantics already make a bare public-suffix signer
 * impossible, and a missed alignment only downgrades to "unauthenticated"
 * (never a spoof).
 */
function authDomainAligned(fromDomain: string, propertyDomain: string, relaxed: boolean): boolean {
  if (!propertyDomain) return false;
  if (propertyDomain === fromDomain) return true;
  if (!relaxed) return false;
  const hasParent = (domain: string) => domain.split('.').length >= 2;
  if (fromDomain.endsWith(`.${propertyDomain}`) && hasParent(propertyDomain)) return true;
  if (propertyDomain.endsWith(`.${fromDomain}`) && hasParent(fromDomain)) return true;
  return false;
}

/**
 * A Workspace domain with no custom DKIM key still gets every outbound message
 * signed by Google, using a per-tenant default key under gappssmtp.com whose
 * first label is the domain with dots rewritten as hyphens
 * (bmson.com → bmson-com.20251104.gappssmtp.com). Plain domain alignment can
 * never match that, so without this a domain that has not published its own
 * DKIM/SPF/DMARC records is permanently unauthenticatable.
 *
 * Accepting it is not a weakening: only Google can sign under gappssmtp.com,
 * the tenant label is derived from the domain rather than chosen by the sender,
 * and the shape is pinned to exactly <domain-as-hyphens>.<selector>.gappssmtp.com
 * so an attacker cannot smuggle a victim's domain in as a deeper subdomain.
 * Publishing real SPF/DKIM/DMARC records remains strictly better.
 */
function googleDefaultDkimAligned(fromDomain: string, propertyDomain: string): boolean {
  const suffix = '.gappssmtp.com';
  if (!fromDomain || !propertyDomain.endsWith(suffix)) return false;
  const labels = propertyDomain.slice(0, -suffix.length).split('.');
  if (labels.length !== 2 || !labels[1]) return false;
  return labels[0] === fromDomain.replaceAll('.', '-');
}

/**
 * A matching From header is identity only when Gmail's own receiver reports
 * aligned SPF, DKIM, or DMARC. Sender-supplied Authentication-Results headers
 * are ignored by requiring Google's authserv-id.
 *
 * Only the TOP-MOST Authentication-Results header is trusted. Gmail prepends
 * its own at delivery, so the receiver's verdict is always first; a sender can
 * inject `Authentication-Results: mx.google.com; dkim=pass ...` deeper in the
 * list, and scanning every header would accept that forgery the moment the
 * ingestion path changes (raw-MIME import, an ARC/forwarder hop, or a
 * non-Gmail receiver that does not strip the sender's copies). Reading only
 * the first header keeps this pinned to the receiver's own line.
 */
export function gmailSenderAuthenticated(
  payload: GmailPayload | undefined,
  fromEmail: string,
): boolean {
  const fromDomain = normalizedAuthDomain(fromEmail);
  if (!fromDomain) return false;
  const topmost = (payload?.headers ?? []).find(
    (header) => header.name.toLowerCase() === 'authentication-results',
  )?.value;
  if (!topmost) return false;

  const clauses = topmost.split(';').map((clause) => clause.trim());
  // The receiver's Authentication-Results must carry Google's authserv-id. If
  // the top header is a sender-supplied one with a different authserv-id, we do
  // not fall through to a lower header — that lower header is untrusted too.
  if (clauses.shift()?.toLowerCase() !== 'mx.google.com') return false;
  for (const clause of clauses) {
    const method = clause.match(/^(dmarc|dkim|spf)=pass\b/i)?.[1]?.toLowerCase();
    if (!method) continue;
    const property =
      method === 'dmarc'
        ? clause.match(/\bheader\.from=([^\s;]+)/i)?.[1]
        : method === 'dkim'
          ? clause.match(/\bheader\.(?:d|i)=([^\s;]+)/i)?.[1]
          : clause.match(/\bsmtp\.mailfrom=([^\s;]+)/i)?.[1];
    const propertyDomain = property ? normalizedAuthDomain(property) : '';
    if (!propertyDomain) continue;
    if (
      authDomainAligned(fromDomain, propertyDomain, method !== 'dmarc') ||
      (method === 'dkim' && googleDefaultDkimAligned(fromDomain, propertyDomain))
    ) {
      return true;
    }
  }
  return false;
}

type ContactTrustByEmail = ReadonlyMap<string, 'owner' | 'known'>;

/**
 * Why a message is not worth triaging. These are deliberately distinct: an
 * unauthenticated message was never identified, whereas an automated one was
 * identified and judged uninteresting. Collapsing them into one "automated"
 * outcome once hid a domain-wide authentication misconfiguration behind a log
 * line claiming the owner's own mail was a newsletter.
 */
type SenderDrop = 'automated' | 'unauthenticated';

/** owner → known → (model: automated?) → unknown */
async function classifySender(
  deps: AgentDeps,
  contactTrustByEmail: ContactTrustByEmail,
  fromEmail: string,
  subject: string,
  snippet: string,
  authenticated: boolean,
): Promise<{ trust: Trust; drop?: SenderDrop }> {
  const contactTrust = contactTrustByEmail.get(fromEmail);
  if (authenticated && contactTrust === 'owner') return { trust: 'owner' };
  if (authenticated && contactTrust === 'known') return { trust: 'known' };
  // A spoofable From value is not a usable identity and must not be allowed to
  // spend classification/model budget merely by reaching the inbox.
  if (!authenticated) return { trust: 'unknown', drop: 'unauthenticated' };

  if (/no-?reply|notifications?@|newsletter|mailer|donotreply/i.test(fromEmail)) {
    return { trust: 'unknown', drop: 'automated' };
  }
  const triage = await deps.router.object<z.infer<typeof AutomatedSchema>>('classify', {
    schema: AutomatedSchema,
    system:
      'Classify whether this email is automated (newsletter/notification/receipt/marketing) or written by a human.',
    prompt: `From: ${fromEmail}\nSubject: ${subject}\nSnippet: ${snippet}`,
    abortSignal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
  });
  if (triage.ok && triage.object.automated) return { trust: 'unknown', drop: 'automated' };
  return { trust: 'unknown' };
}

/**
 * Dropping mail that claims a trusted identity is the signal that the domain's
 * SPF/DKIM/DMARC records are wrong — the failure mode this exists to surface.
 * The From value is spoofable, so anyone can provoke this: the notice is
 * throttled per address to keep it a signal rather than an amplifier, and the
 * log line always stands on its own for alerting.
 */
const OWNER_SPOOF_NOTICE_INTERVAL_MS = 60 * 60 * 1000;
const lastUnauthenticatedNoticeAt = new Map<string, number>();

async function reportUnauthenticatedTrustedSender(
  deps: AgentDeps,
  fromEmail: string,
  subject: string,
): Promise<void> {
  const now = Date.now();
  const previous = lastUnauthenticatedNoticeAt.get(fromEmail);
  if (previous !== undefined && now - previous < OWNER_SPOOF_NOTICE_INTERVAL_MS) return;
  lastUnauthenticatedNoticeAt.set(fromEmail, now);
  await notifyOwnerBySms(deps, {
    text:
      `Dropped an email claiming to be from ${fromEmail} ("${subject.slice(0, 60)}") — ` +
      'it failed SPF/DKIM/DMARC checks. If you sent it, that domain is missing email ' +
      'authentication records and the assistant cannot accept its mail.',
  }).catch((err) => console.error('unauthenticated-sender notice failed', err));
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

export async function processMessage(
  deps: AgentDeps,
  agentId: string,
  botEmail: string,
  contactTrustByEmail: ContactTrustByEmail,
  messageId: string,
): Promise<'triaged' | 'skipped'> {
  const channelMessageId = `gmail:${messageId}`;
  const [[existing], [existingTask]] = await Promise.all([
    deps.db
      .select({
        id: storedMessages.id,
        conversationId: storedMessages.conversationId,
        origin: storedMessages.origin,
      })
      .from(storedMessages)
      .where(eq(storedMessages.channelMessageId, channelMessageId))
      .limit(1),
    deps.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.externalEventId, channelMessageId))
      .limit(1),
  ]);
  // History replays are normal after a partial page failure. Fetch current
  // metadata again, but avoid paying to classify a message already persisted.
  if (existingTask) return 'skipped';

  const msg = await deps.googleClient.api<GmailMessage>(
    `${GMAIL}/messages/${messageId}?format=full&fields=id,threadId,labelIds,snippet,payload`,
    { signal: AbortSignal.timeout(MESSAGE_FETCH_TIMEOUT_MS) },
  );
  const from = parseSenderEmail(gmailHeader(msg.payload, 'From'));
  const subject = gmailHeader(msg.payload, 'Subject');
  // RFC-822 Message-ID header (distinct from msg.id, the Gmail internal id).
  // Captured here from the format=full payload so the reply path can thread
  // (In-Reply-To/References) without a second per-send metadata fetch.
  const rfcMessageId = gmailHeader(msg.payload, 'Message-ID');

  // Never triage the bot's own outbound mail.
  if (from === botEmail.toLowerCase()) return 'skipped';
  if (!msg.labelIds?.includes('INBOX')) return 'skipped';

  const text = extractGmailText(msg.payload).slice(0, 20000);
  const authenticated = gmailSenderAuthenticated(msg.payload, from);
  const application = await processApplicationConfirmation(deps, {
    agentId,
    messageId: msg.id,
    from,
    subject,
    body: text,
    authenticated,
  });
  if (application.kind !== 'ignored') return 'triaged';

  // Anticipation layer: fire any owner-defined inbox watchers this message
  // matches. Side-effect only (a notice + owner ping) — a watched message is
  // still an ordinary email, so this never short-circuits normal triage.
  await matchEmailWatches(deps, {
    agentId,
    messageId: msg.id,
    from,
    subject,
    body: text,
    authenticated,
  }).catch((err) => console.error('watch matching failed', err));

  // Recover the narrow crash window after message persistence but before task
  // creation without paying for sender classification again.
  if (existing) {
    const persistedTrust: Trust =
      existing.origin === 'owner'
        ? 'owner'
        : existing.origin === 'known_contact'
          ? 'known'
          : 'unknown';
    const { created } = await enqueueTask(deps.db, {
      type: 'email_triage',
      // Email triage now reasons with tools (roleForTask → reason); give it the
      // same step headroom as a goal session so a browse-and-reply can complete.
      maxSteps: 16,
      event: {
        source: 'email',
        externalEventId: channelMessageId,
        agentId,
        conversationId: existing.conversationId,
        trust: persistedTrust,
        payload: {
          threadId: msg.threadId,
          messageId: msg.id,
          rfcMessageId,
          from,
          subject,
          quotesExternalContent: quotesExternalContent({ subject, body: text }),
        },
      },
    });
    return created ? 'triaged' : 'skipped';
  }

  const { trust, drop } = await classifySender(
    deps,
    contactTrustByEmail,
    from,
    subject,
    msg.snippet ?? '',
    authenticated,
  );
  if (drop === 'unauthenticated') {
    console.warn(
      `email-sync: dropping unauthenticated mail from ${from} ("${subject.slice(0, 40)}") — ` +
        'no aligned SPF/DKIM/DMARC pass from mx.google.com',
    );
    if (contactTrustByEmail.has(from)) {
      await reportUnauthenticatedTrustedSender(deps, from, subject);
    }
    return 'skipped';
  }
  if (drop === 'automated') {
    console.log(`email-sync: skipping automated mail from ${from} ("${subject.slice(0, 40)}")`);
    return 'skipped';
  }

  const conversationId = await conversationForThread(deps, agentId, msg.threadId, trust, subject);
  const persisted = await persistMessage(deps.db, {
    conversationId,
    role: 'user',
    origin: trust === 'owner' ? 'owner' : trust === 'known' ? 'known_contact' : 'unknown',
    parts: [{ type: 'text', text }],
    text: `From: ${from}\nSubject: ${subject}\n\n${text}`,
    channelMessageId,
  });
  if (!persisted) return 'skipped'; // another instance won the idempotency race

  // Opportunistically learn the owner's voice from their own authenticated,
  // non-forwarded mail. Gated on owner trust + not quoting external content so
  // no third-party text ever enters the private voice corpus. Best-effort.
  if (trust === 'owner' && !quotesExternalContent({ subject, body: text })) {
    await captureOwnerWritingSample(deps.db, deps.router, {
      text,
      register: 'email_casual',
      context: 'inbound-email',
    }).catch((err) => console.error('voice sampling failed', err));
  }

  const { created } = await enqueueTask(deps.db, {
    type: 'email_triage',
    // Email triage now reasons with tools (roleForTask → reason); give it the
    // same step headroom as a goal session so a browse-and-reply can complete.
    maxSteps: 16,
    event: {
      source: 'email',
      externalEventId: `gmail:${msg.id}`,
      agentId,
      conversationId,
      trust,
      payload: {
        threadId: msg.threadId,
        messageId: msg.id,
        rfcMessageId,
        from,
        subject,
        quotesExternalContent: quotesExternalContent({ subject, body: text }),
      },
    },
  });
  if (created) console.log(`email-sync: triage task for ${from} ("${subject.slice(0, 40)}")`);
  return 'triaged';
}

/**
 * Incremental Gmail sync. Pub/Sub pushes and the local poll both land here —
 * the notification is only a poke; history.list is the source of truth.
 * Work is durably checkpointed within each page and bounded per invocation.
 * A stale history cursor falls back to a resumable current-inbox reconciliation
 * instead of silently advancing past messages we have never inspected.
 */
async function syncMailboxOnce(deps: AgentDeps): Promise<MailboxSyncResult> {
  if (!deps.googleClient.configured()) return { processed: 0 };
  const agent = await getAgent(deps.db);
  const botEmail = agent.email;

  const [[state], profile, contactRows] = await Promise.all([
    deps.db.select().from(gmailSyncState).where(eq(gmailSyncState.mailbox, botEmail)),
    deps.googleClient.api<{ historyId: string }>(`${GMAIL}/profile`),
    deps.db.select({ emails: contacts.emails, trust: contacts.trust }).from(contacts),
  ]);
  const contactTrustByEmail = new Map<string, 'owner' | 'known'>();
  for (const contact of contactRows) {
    if (contact.trust !== 'owner' && contact.trust !== 'known') continue;
    for (const email of contact.emails) contactTrustByEmail.set(email.toLowerCase(), contact.trust);
  }

  if (!state?.lastHistoryId) {
    const baseline = BigInt(profile.historyId);
    await deps.db
      .insert(gmailSyncState)
      .values({ mailbox: botEmail, lastHistoryId: baseline })
      .onConflictDoUpdate({
        target: gmailSyncState.mailbox,
        set: {
          lastHistoryId: sql`GREATEST(${gmailSyncState.lastHistoryId}, ${baseline})`,
          updatedAt: new Date(),
        },
      });
    console.log(`email-sync: baseline set at historyId ${profile.historyId}`);
    return { processed: 0 };
  }

  const rawCursor = state.cursor as Record<string, unknown> | null;
  let cursor: GmailDrainCursor;
  if (rawCursor && Object.keys(rawCursor).length > 0) {
    cursor = GmailDrainCursorSchema.parse(rawCursor);
  } else {
    cursor = {
      mode: 'history',
      startHistoryId: String(state.lastHistoryId),
      targetHistoryId: profile.historyId,
    };
  }

  const saveCursor = async () => {
    await deps.db
      .update(gmailSyncState)
      .set({ cursor, updatedAt: new Date() })
      .where(eq(gmailSyncState.mailbox, botEmail));
  };
  // Publish the fixed target before any page work. A crash therefore resumes
  // the same drain instead of moving the baseline to a newer mailbox state.
  if (!rawCursor || Object.keys(rawCursor).length === 0) await saveCursor();

  let processed = 0;
  let handled = 0;
  let pagesFetched = 0;
  const startedAt = Date.now();

  while (true) {
    if (!cursor.pending) {
      if (pagesFetched >= MAX_PAGES_PER_SYNC) return { processed, morePending: true };

      if (cursor.mode === 'history') {
        const url = new URL(`${GMAIL}/history`);
        url.searchParams.set('startHistoryId', cursor.startHistoryId as string);
        url.searchParams.append('historyTypes', 'messageAdded');
        url.searchParams.append('historyTypes', 'labelAdded');
        url.searchParams.set('labelId', 'INBOX');
        url.searchParams.set('maxResults', String(HISTORY_PAGE_SIZE));
        if (cursor.pageToken) url.searchParams.set('pageToken', cursor.pageToken);
        try {
          const page = await deps.googleClient.api<{
            history?: Array<{
              messagesAdded?: Array<{ message: { id: string } }>;
              labelsAdded?: Array<{ message: { id: string }; labelIds?: string[] }>;
            }>;
            nextPageToken?: string;
          }>(url.toString());
          const ids = new Set<string>();
          for (const history of page.history ?? []) {
            for (const added of history.messagesAdded ?? []) ids.add(added.message.id);
            for (const labeled of history.labelsAdded ?? []) {
              if (labeled.labelIds?.includes('INBOX')) ids.add(labeled.message.id);
            }
          }
          cursor.pending = {
            messageIds: [...ids],
            index: 0,
            ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
          };
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          console.warn('email-sync: stale historyId, reconciling the current inbox');
          cursor = { mode: 'inbox', targetHistoryId: profile.historyId };
          await saveCursor();
          continue;
        }
      } else {
        const url = new URL(`${GMAIL}/messages`);
        url.searchParams.append('labelIds', 'INBOX');
        url.searchParams.set('maxResults', String(HISTORY_PAGE_SIZE));
        if (cursor.pageToken) url.searchParams.set('pageToken', cursor.pageToken);
        const page = await deps.googleClient.api<{
          messages?: Array<{ id: string }>;
          nextPageToken?: string;
        }>(url.toString());
        cursor.pending = {
          messageIds: (page.messages ?? []).map((message) => message.id),
          index: 0,
          ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
        };
      }
      pagesFetched += 1;
      // Persist message ids before classification. Automated/ignored messages
      // therefore do not incur repeated model cost after a later-page crash.
      await saveCursor();
    }

    const pending = cursor.pending;
    while (pending.index < pending.messageIds.length) {
      if (
        handled >= MAX_MESSAGES_PER_SYNC ||
        (handled > 0 && Date.now() - startedAt >= MAX_SYNC_WALL_MS)
      ) {
        return { processed, morePending: true };
      }
      const messageId = pending.messageIds[pending.index] as string;
      try {
        if (
          (await processMessage(deps, agent.id, botEmail, contactTrustByEmail, messageId)) ===
          'triaged'
        ) {
          processed += 1;
        }
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        // Deleted between list and fetch: this id is durably consumed too.
      }
      pending.index += 1;
      handled += 1;
      await saveCursor();
    }

    const nextPageToken = pending.nextPageToken;
    cursor.pageToken = nextPageToken;
    cursor.pending = undefined;
    if (nextPageToken) {
      await saveCursor();
      continue;
    }

    await deps.db
      .update(gmailSyncState)
      .set({
        lastHistoryId: sql`GREATEST(${gmailSyncState.lastHistoryId}, ${BigInt(cursor.targetHistoryId)})`,
        cursor: {},
        updatedAt: new Date(),
      })
      .where(eq(gmailSyncState.mailbox, botEmail));
    return { processed };
  }
}

/**
 * Cross-instance guard. The in-process coordinator handles concurrent routes
 * on one Cloud Run instance; this session advisory lock prevents two scaled
 * instances from both paying to classify the same not-yet-persisted message.
 */
async function syncMailboxWithDistributedLock(deps: AgentDeps): Promise<MailboxSyncResult> {
  const connection = await deps.db.$client.reserve();
  let acquired = false;
  try {
    const [row] = await connection<[{ acquired: boolean }]>`
      select pg_try_advisory_lock(hashtext('assistant:gmail-sync')) as acquired
    `;
    acquired = row?.acquired === true;
    // Another instance is already draining the same durable cursor. That is
    // expected single-flight behavior, not a failed Scheduler execution; the
    // next push or minute tick will pick up anything still pending.
    if (!acquired) return { processed: 0, morePending: true };
    return await syncMailboxOnce(deps);
  } finally {
    if (acquired) {
      await connection`select pg_advisory_unlock(hashtext('assistant:gmail-sync'))`.catch((error) =>
        console.error('email-sync: failed to release advisory lock', error),
      );
    }
    connection.release();
  }
}

let nextSyncDeps: AgentDeps | undefined;
const mailboxSyncCoordinator = new MailboxSyncCoordinator(async () => {
  if (!nextSyncDeps) throw new Error('mailbox sync dependencies unavailable');
  return syncMailboxWithDistributedLock(nextSyncDeps);
});

/** Single-flight entry point used by polling, internal calls, and Pub/Sub. */
export function syncMailbox(deps: AgentDeps): Promise<MailboxSyncResult> {
  nextSyncDeps = deps;
  return mailboxSyncCoordinator.sync();
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
