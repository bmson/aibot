import { createHash } from 'node:crypto';
import { type Config, isModuleEnabled } from '@assistant/config';
import type { ModelRouter, Trust } from '@assistant/core';
import {
  captureOwnerWritingSample,
  enqueueTask,
  extractorFor,
  getAgent,
  persistMessage,
  quotesExternalContent,
  startDocumentIngest,
  TaskRateLimitError,
} from '@assistant/core';
import {
  channelBindings,
  contacts,
  conversations,
  type Db,
  emailIngest,
  gmailSyncState,
  messages as storedMessages,
  tasks,
} from '@assistant/db';
import {
  collectGmailAttachments,
  extractGmailText,
  type GmailPayload,
  gmailHeader,
  safeRelPath,
} from '@assistant/tools';
import type { GoogleClient } from '@assistant/tools/modules/google';
import type { WorkspaceStore } from '@assistant/tools/workspace';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { InboundEmailEvent, OwnerNotifier } from '../platform.js';
import { processApplicationConfirmation } from './application-confirmations.js';
import { scoreEmailImportance } from './email-importance.js';
import { emailIngestForwarded } from './meta.js';

/**
 * What mail sync consumes. The client comes from the module's own create()
 * closure; the notifier and observer fan-out are platform ports, so this file
 * needs neither the sms module nor the agent's dependency graph.
 */
export interface EmailSyncDeps {
  config: Config;
  db: Db;
  router: ModelRouter;
  workspace: WorkspaceStore;
  googleClient: GoogleClient;
  notifyOwner: OwnerNotifier['notifyOwner'];
  /** Fan an authenticated inbound message out to observing modules (watches). */
  observeInboundEmail: (event: InboundEmailEvent) => Promise<void>;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HISTORY_PAGE_SIZE = 25;
const MAX_MESSAGES_PER_SYNC = 10;
const MAX_PAGES_PER_SYNC = 2;
const MAX_SYNC_WALL_MS = 90_000;
const MESSAGE_FETCH_TIMEOUT_MS = 30_000;
const CLASSIFY_TIMEOUT_MS = 20_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;

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
 * and the shape is pinned to exactly <domain-as-hyphens>.<selector>.gappssmtp.com.
 *
 * BUT the domain→label map (dots→hyphens) is lossy: `mail.example.com` and the
 * registrable sibling `mail-example.com` both produce `mail-example-com`, so an
 * attacker who registers a hyphenated sibling of a victim domain and onboards
 * Workspace is issued an identical tenant label. The label alone cannot
 * disambiguate them. The exemption is therefore restricted to the ONE shape
 * whose label reverses unambiguously — a registrable domain with exactly one
 * dot and no hyphen (`example.com` → `example-com`, and no valid registrable
 * domain other than `example.com` maps to that label). Subdomains and
 * hyphenated domains must publish real SPF/DKIM/DMARC, or align to their org
 * domain via the relaxed rule. Publishing real records remains strictly better.
 */
function googleDefaultDkimAligned(fromDomain: string, propertyDomain: string): boolean {
  const suffix = '.gappssmtp.com';
  if (!fromDomain || !propertyDomain.endsWith(suffix)) return false;
  // Only a hyphen-free, single-dot registrable domain has an unambiguous label.
  if (fromDomain.includes('-') || fromDomain.split('.').length !== 2) return false;
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
/**
 * Strip RFC-5322 comments `( ... )` (which nest) and quoted strings `"..."`
 * from a structured header value before it is split on `;`.
 *
 * Gmail echoes the sender's envelope-from into the SPF clause — both inside a
 * `(google.com: domain of <addr> ...)` comment and in `smtp.mailfrom=<addr>`.
 * An attacker using an RFC-5321-legal quoted local part can smuggle a `;` and a
 * synthetic `dkim=pass header.d=<owner>` clause through the naive split, forging
 * authentication for the owner's domain. Dropping comments and quoted spans
 * first removes every sender-controlled span that could carry a delimiter.
 */
function stripCommentsAndQuotes(value: string): string {
  let out = '';
  let commentDepth = 0;
  let inQuote = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\') {
      // A backslash escapes the next char inside a comment or quoted string.
      if (inQuote || commentDepth > 0) i += 1;
      else out += ch;
      continue;
    }
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (commentDepth > 0) {
      if (ch === '(') commentDepth += 1;
      else if (ch === ')') commentDepth -= 1;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === '(') commentDepth += 1;
    else out += ch;
  }
  return out;
}

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

  const clauses = stripCommentsAndQuotes(topmost)
    .split(';')
    .map((clause) => clause.trim());
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
  deps: EmailSyncDeps,
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
 * Sender trust for forwarded ingest, with nothing dropped.
 *
 * `classifySender` answers two questions at once — who is this, and is it worth
 * bothering with — and drops the message when the second answer is no. In
 * forwarded mode only the first question belongs here: the owner pointed their
 * whole inbox at the assistant, so "worth bothering with" is the importance
 * scorer's job, and it needs the message to still exist to score it.
 *
 * An unauthenticated sender is downgraded to `unknown` rather than dropped.
 * Forwarding breaks SPF by construction (the forwarding host is not in the
 * original sender's SPF record), so dropping on failed authentication would
 * silently discard a large share of genuinely forwarded mail. The trust value
 * still carries the verdict onward, and every outward action stays gated.
 *
 * Deliberately model-free: forwarded mode pays for one importance call per
 * message, and adding an automated/human call on top would double that for an
 * answer the importance score already subsumes.
 */
function ingestContentTrust(
  contactTrustByEmail: ContactTrustByEmail,
  fromEmail: string,
  authenticated: boolean,
): Trust {
  if (!authenticated) return 'unknown';
  return contactTrustByEmail.get(fromEmail) ?? 'unknown';
}

/**
 * Have we already spent today's allowance of deep triage tasks?
 *
 * The platform's flood backstop (`underExternalTaskLimit`) counts only
 * `known`/`unknown` root tasks, because those are what a third party can create
 * by sending mail. Ingest tasks run at OWNER trust — the owner's forwarding rule
 * is what created them — so they slip past it entirely. Without this brake a
 * single busy day, or one sender looping, could burn a month of model budget.
 *
 * Counted over a rolling 24 hours rather than a calendar day so a burst at
 * midnight cannot spend two days' allowance in two minutes.
 */
async function underIngestTriageLimit(db: Db, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(emailIngest)
    .where(
      and(
        eq(emailIngest.triaged, true),
        gte(emailIngest.createdAt, sql`now() - '1 day'::interval`),
      ),
    );
  return Number(row?.n ?? 0) < limit;
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
  deps: EmailSyncDeps,
  fromEmail: string,
  subject: string,
): Promise<void> {
  const now = Date.now();
  const previous = lastUnauthenticatedNoticeAt.get(fromEmail);
  if (previous !== undefined && now - previous < OWNER_SPOOF_NOTICE_INTERVAL_MS) return;
  lastUnauthenticatedNoticeAt.set(fromEmail, now);
  await deps
    .notifyOwner({
      text:
        `Dropped an email claiming to be from ${fromEmail} ("${subject.slice(0, 60)}") — ` +
        'it failed SPF/DKIM/DMARC checks. If you sent it, that domain is missing email ' +
        'authentication records and the assistant cannot accept its mail.',
    })
    .catch((err) => console.error('unauthenticated-sender notice failed', err));
}

async function conversationForThread(
  deps: EmailSyncDeps,
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

/**
 * Auto-file the attachments of an authenticated message from someone we know
 * as searchable documents (Phase 11). Best-effort and fail-open: a fetch or
 * store error on one attachment is logged and skipped, and the whole pass is
 * wrapped by the caller — attachment filing never blocks or fails triage.
 * Dedup is by content hash, so a Gmail history replay re-files nothing.
 */
async function fileMessageAttachments(
  deps: EmailSyncDeps,
  input: { agentId: string; message: GmailMessage; trust: Trust },
): Promise<void> {
  if (!isModuleEnabled(deps.config, 'documents')) return;
  const attachments = collectGmailAttachments(input.message.payload).slice(
    0,
    MAX_ATTACHMENTS_PER_MESSAGE,
  );
  for (const att of attachments) {
    try {
      // Skip formats we can neither read in-process nor hand to the processor.
      if (extractorFor(att.mimeType, att.filename) === 'unsupported') continue;
      if (att.size > MAX_ATTACHMENT_BYTES) continue;
      const res = await deps.googleClient.api<{ data?: string }>(
        `${GMAIL}/messages/${input.message.id}/attachments/${att.attachmentId}`,
        { signal: AbortSignal.timeout(MESSAGE_FETCH_TIMEOUT_MS) },
      );
      const bytes = res.data ? Buffer.from(res.data, 'base64url') : Buffer.alloc(0);
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
      const cleanName =
        att.filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
      const workspacePath = safeRelPath(`documents/email/${input.message.id}-${cleanName}`);
      await deps.workspace.writeBytes(workspacePath, bytes, att.mimeType);
      const result = await startDocumentIngest(deps.db, {
        agentId: input.agentId,
        title: att.filename.slice(0, 300),
        workspacePath,
        mime: att.mimeType,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        source: 'email',
        sourceRef: `gmail:${input.message.id}`,
        trust: input.trust,
      });
      if (result.duplicate) await deps.workspace.delete(workspacePath).catch(() => {});
    } catch (err) {
      console.error(`email-sync: failed to file attachment ${att.filename}`, err);
    }
  }
}

interface ForwardedIngestInput {
  agentId: string;
  message: GmailMessage;
  from: string;
  subject: string;
  text: string;
  rfcMessageId: string;
  authenticated: boolean;
  contactTrustByEmail: ContactTrustByEmail;
  channelMessageId: string;
}

/**
 * Handle one message in forwarded-ingest mode: keep everything, score it, and
 * spend a triage task only on what earned one.
 *
 * The trust split is the whole point of this function. The task is enqueued at
 * OWNER trust because the owner's standing forwarding rule is what asked for
 * this work — that is what gives it access to the owner's own calendar, files,
 * memory and notifications, none of which a `known`/`unknown` task can reach
 * (`ToolRegistry.toolsForTask` strips them). It is simultaneously marked as
 * quoting external content, which forces `shouldTaintContext` to taint the
 * session, so every outward-facing, network, or memory-writing call still needs
 * the owner to approve it. Direction and authorship are different axes, and the
 * sender only ever decides the second one.
 */
async function processForwardedIngest(
  deps: EmailSyncDeps,
  input: ForwardedIngestInput,
): Promise<'triaged' | 'skipped'> {
  const { agentId, message: msg, from, subject, text, channelMessageId } = input;
  const threshold = deps.config.EMAIL_INGEST_IMPORTANCE_THRESHOLD;

  const [recorded] = await deps.db
    .select({
      id: emailIngest.id,
      conversationId: emailIngest.conversationId,
      importance: emailIngest.importance,
      category: emailIngest.category,
      contentTrust: emailIngest.contentTrust,
      triaged: emailIngest.triaged,
    })
    .from(emailIngest)
    .where(eq(emailIngest.channelMessageId, channelMessageId))
    .limit(1);

  // A Gmail history replay re-delivers messages we have already scored. Never
  // pay to score one twice; only finish the work that a crash left undone.
  if (recorded) {
    if (recorded.triaged || recorded.importance < threshold || !recorded.conversationId) {
      return 'skipped';
    }
    const enqueued = await enqueueIngestTriage(deps, {
      ...input,
      conversationId: recorded.conversationId,
      contentTrust: recorded.contentTrust as Trust,
      importance: recorded.importance,
      category: recorded.category,
      ingestId: recorded.id,
    });
    return enqueued ? 'triaged' : 'skipped';
  }

  const contentTrust = ingestContentTrust(input.contactTrustByEmail, from, input.authenticated);
  const score = await scoreEmailImportance(deps.router, {
    from,
    subject,
    body: text,
    ...(msg.payload ? { payload: msg.payload } : {}),
    contentTrust,
    authenticated: input.authenticated,
  });

  // The conversation still carries the SENDER's trust: it is what memory
  // extraction reads to decide quarantine, and a stranger's claims must not
  // become owner-trust facts just because the owner forwarded the message.
  const conversationId = await conversationForThread(
    deps,
    agentId,
    msg.threadId,
    contentTrust,
    subject,
  );
  const persisted = await persistMessage(deps.db, {
    conversationId,
    role: 'user',
    origin:
      contentTrust === 'owner' ? 'owner' : contentTrust === 'known' ? 'known_contact' : 'unknown',
    parts: [{ type: 'text', text }],
    text: `From: ${from}\nSubject: ${subject}\n\n${text}`,
    channelMessageId,
  });
  if (!persisted) return 'skipped'; // another instance won the idempotency race

  const [ingested] = await deps.db
    .insert(emailIngest)
    .values({
      agentId,
      conversationId,
      channelMessageId,
      fromEmail: from,
      subject: subject.slice(0, 500),
      contentTrust,
      authenticated: input.authenticated,
      category: score.category,
      importance: score.importance,
      actionable: score.actionable,
      reason: score.reason.slice(0, 300),
      dates: score.dates,
    })
    .onConflictDoNothing({ target: emailIngest.channelMessageId })
    .returning({ id: emailIngest.id });
  if (!ingested) return 'skipped'; // concurrent instance recorded it first

  // Learn the owner's voice only from their own verified, non-forwarded prose.
  if (contentTrust === 'owner' && !quotesExternalContent({ subject, body: text })) {
    await captureOwnerWritingSample(deps.db, deps.router, {
      text,
      register: 'email_casual',
      context: 'inbound-email',
    }).catch((err) => console.error('voice sampling failed', err));
  }

  // File attachments from everything except bulk marketing, so the owner's mail
  // becomes a searchable document archive. Dedupe is by content hash, so a
  // replay re-files nothing.
  if (score.importance > 1) {
    await fileMessageAttachments(deps, { agentId, message: msg, trust: contentTrust }).catch(
      (err) => console.error('attachment filing failed', err),
    );
  }

  if (score.importance < threshold) {
    console.log(
      `email-sync: ingested ${from} ("${subject.slice(0, 40)}") at importance ${score.importance} — stored without triage`,
    );
    return 'skipped';
  }

  const enqueued = await enqueueIngestTriage(deps, {
    ...input,
    conversationId,
    contentTrust,
    importance: score.importance,
    category: score.category,
    ingestId: ingested.id,
  });
  return enqueued ? 'triaged' : 'skipped';
}

/**
 * Enqueue the deep triage task for an ingested message, subject to the daily
 * ceiling. Returns whether a task was created.
 */
async function enqueueIngestTriage(
  deps: EmailSyncDeps,
  input: ForwardedIngestInput & {
    conversationId: string;
    contentTrust: Trust;
    importance: number;
    category: string;
    ingestId: string;
  },
): Promise<boolean> {
  if (!(await underIngestTriageLimit(deps.db, deps.config.EMAIL_INGEST_MAX_TRIAGE_PER_DAY))) {
    console.warn(
      `email-sync: daily ingest triage ceiling reached; storing ${input.from} without triage`,
    );
    return false;
  }

  const { created } = await enqueueTask(deps.db, {
    type: 'email_triage',
    maxSteps: 16,
    // 16 steps on the reason role does not fit the default $0.50 cap: the soft
    // fallback threshold trips around step 6 and the hard cap around step 10,
    // leaving the tail unrunnable. This is a ceiling, not typical spend.
    budgetUsdLimit: '1.20',
    event: {
      source: 'email',
      externalEventId: input.channelMessageId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      // The OWNER directed this ingest; see processForwardedIngest.
      trust: 'owner',
      payload: {
        threadId: input.message.threadId,
        messageId: input.message.id,
        rfcMessageId: input.rfcMessageId,
        from: input.from,
        subject: input.subject,
        // Always true for ingest: the body is a third party's words arriving
        // through the owner's pipe, so the session must run tainted.
        quotesExternalContent: true,
        ingest: {
          forwarded: true,
          contentTrust: input.contentTrust,
          authenticated: input.authenticated,
          importance: input.importance,
          category: input.category,
        },
      },
    },
  });

  if (created) {
    await deps.db
      .update(emailIngest)
      .set({ triaged: true, updatedAt: new Date() })
      .where(eq(emailIngest.id, input.ingestId));
    console.log(
      `email-sync: triaging ${input.from} ("${input.subject.slice(0, 40)}") — ${input.category}, importance ${input.importance}`,
    );
  }
  return created;
}

export async function processMessage(
  deps: EmailSyncDeps,
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

  // Anticipation layer: fan the authenticated message out to every installed
  // module observing inbound email (watches today). Side effects only (a
  // notice + owner ping) — a watched message is still an ordinary email, so
  // this never short-circuits normal triage.
  await deps
    .observeInboundEmail({ agentId, messageId: msg.id, from, subject, body: text, authenticated })
    .catch((err) => console.error('inbound email observer failed', err));

  if (emailIngestForwarded(deps.config)) {
    return processForwardedIngest(deps, {
      agentId,
      message: msg,
      from,
      subject,
      text,
      rfcMessageId,
      authenticated,
      contactTrustByEmail,
      channelMessageId,
    });
  }

  // Recover the narrow crash window after message persistence but before task
  // creation without paying for sender classification again.
  if (existing) {
    const persistedTrust: Trust =
      existing.origin === 'owner'
        ? 'owner'
        : existing.origin === 'known_contact'
          ? 'known'
          : 'unknown';
    let created = false;
    try {
      ({ created } = await enqueueTask(deps.db, {
        type: 'email_triage',
        // Email triage reasons with tools (roleForTask → reason) on Sonnet, so
        // its 16-step headroom for a browse-and-reply only exists if the budget
        // covers it: the default $0.50 cap trips the soft-fallback threshold
        // around step 6 and the hard cap around step 10, leaving the tail
        // unrunnable. This is a per-task CEILING, not typical spend — most
        // emails finish in a few steps — and daily/monthly caps still bound the
        // total. Keeping the pair honest matters more than a lower ceiling.
        maxSteps: 16,
        budgetUsdLimit: '1.20',
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
      }));
    } catch (error) {
      // The flood backstop skips this message rather than failing the sync:
      // a thrown error here would stall the history cursor and make Pub/Sub
      // redeliver the same burst that tripped the limit.
      if (error instanceof TaskRateLimitError) {
        console.warn(`email-sync: task rate limit reached; skipping triage for ${from}`);
        return 'skipped';
      }
      throw error;
    }
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

  // Auto-file attachments from authenticated people we know, so the owner can
  // ask about them (Phase 11). Best-effort — never blocks triage.
  if (authenticated && (trust === 'owner' || trust === 'known')) {
    await fileMessageAttachments(deps, { agentId, message: msg, trust }).catch((err) =>
      console.error('attachment filing failed', err),
    );
  }

  let created = false;
  try {
    ({ created } = await enqueueTask(deps.db, {
      type: 'email_triage',
      // Email triage now reasons with tools (roleForTask → reason); give it the
      // same step headroom as a goal session so a browse-and-reply can complete.
      maxSteps: 16,
      // Must match the step headroom above: at the default $0.50 cap the soft
      // fallback threshold trips around step 6 and the hard cap around step 10,
      // so the last third of a 16-step task could never run. This is a per-task
      // ceiling rather than typical spend, and the daily/monthly caps still
      // bound the total.
      budgetUsdLimit: '1.20',
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
    }));
  } catch (error) {
    // Same skip-not-stall reasoning as the persisted-thread path above.
    if (error instanceof TaskRateLimitError) {
      console.warn(`email-sync: task rate limit reached; skipping triage for ${from}`);
      return 'skipped';
    }
    throw error;
  }
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
async function syncMailboxOnce(deps: EmailSyncDeps): Promise<MailboxSyncResult> {
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
export async function syncMailboxWithDistributedLock(
  deps: EmailSyncDeps,
): Promise<MailboxSyncResult> {
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

/** Renew users.watch (Gmail push). Requires GMAIL_PUBSUB_TOPIC; expires in 7 days. */
export async function renewWatch(deps: EmailSyncDeps, topicName: string): Promise<Date> {
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
