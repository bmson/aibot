import {
  channelBindings,
  conversations,
  createDb,
  type Db,
  emailIngest,
  messages,
  tasks,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type EmailSyncDeps,
  gmailSenderAuthenticated,
  importantEmailNotice,
  MailboxSyncCoordinator,
  type MailboxSyncResult,
  processForwardedIngest,
} from './email-sync.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const { getAgent } = await import('@assistant/core/chat');
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-sync owner-alert tests: database unreachable — skipping');
  }
});

afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MailboxSyncCoordinator', () => {
  it('coalesces concurrent pokes and drains once more when dirtied during each pass', async () => {
    const passes = [
      deferred<MailboxSyncResult>(),
      deferred<MailboxSyncResult>(),
      deferred<MailboxSyncResult>(),
    ];
    const runOnce = vi.fn(() => {
      const pass = passes[runOnce.mock.calls.length - 1];
      if (!pass) throw new Error('unexpected pass');
      return pass.promise;
    });
    const coordinator = new MailboxSyncCoordinator(runOnce);

    const first = coordinator.sync();
    expect(runOnce).toHaveBeenCalledTimes(1);
    const concurrent = coordinator.sync();
    expect(concurrent).toBe(first);
    coordinator.sync(); // multiple pokes still coalesce to one extra pass

    passes[0]?.resolve({ processed: 1 });
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(2));
    coordinator.sync(); // a poke during the second pass must force a third
    passes[1]?.resolve({ processed: 2 });
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(3));
    passes[2]?.resolve({ processed: 3 });

    await expect(first).resolves.toEqual({ processed: 6 });
    await expect(concurrent).resolves.toEqual({ processed: 6 });
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('allows a fresh drain after a failed pass', async () => {
    const runOnce = vi
      .fn<() => Promise<MailboxSyncResult>>()
      .mockRejectedValueOnce(new Error('temporary Gmail failure'))
      .mockResolvedValueOnce({ processed: 4 });
    const coordinator = new MailboxSyncCoordinator(runOnce);

    await expect(coordinator.sync()).rejects.toThrow('temporary Gmail failure');
    await expect(coordinator.sync()).resolves.toEqual({ processed: 4 });
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});

describe('Gmail sender authentication', () => {
  const payload = (authenticationResults: string) => ({
    headers: [{ name: 'Authentication-Results', value: authenticationResults }],
  });

  it('accepts a Gmail-verified, aligned sender domain', () => {
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dmarc=pass (p=reject) header.from=example.com'),
        'owner@example.com',
      ),
    ).toBe(true);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@example.com header.s=mail'),
        'owner@example.com',
      ),
    ).toBe(true);
  });

  it('accepts the Google Workspace default DKIM key for a domain with no custom key', () => {
    // Verbatim header from bot@bmson.com: a Workspace domain that publishes no
    // SPF/DKIM/DMARC still gets a Google-signed per-tenant gappssmtp key. Before
    // this was accepted, every message from the owner's own domain was dropped.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com;       dkim=pass header.i=@bmson-com.20251104.gappssmtp.com header.s=20251104 header.b=qLVdIQJT;       arc=pass (i=1);       spf=none (google.com: bmson@bmson.com does not designate permitted sender hosts) smtp.mailfrom=bmson@bmson.com;       dara=neutral header.i=@bmson.com',
        ),
        'bmson@bmson.com',
      ),
    ).toBe(true);
  });

  it('does not let the gappssmtp exemption authenticate a domain it was not issued for', () => {
    // The tenant label is derived from the domain, so a key issued to one
    // Workspace tenant must never authenticate another domain, and a victim
    // domain smuggled in as a deeper subdomain must not match either.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@attacker-example.20251104.gappssmtp.com'),
        'owner@example.com',
      ),
    ).toBe(false);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@example-com.evil.20251104.gappssmtp.com'),
        'owner@example.com',
      ),
    ).toBe(false);
    // SPF/DMARC clauses get no such exemption — only Google signs DKIM keys.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; spf=pass smtp.mailfrom=example-com.20251104.gappssmtp.com'),
        'owner@example.com',
      ),
    ).toBe(false);
    // The lossy dots→hyphens map: a subdomain victim (mail.example.com) shares a
    // tenant label with the registrable sibling mail-example.com, so the
    // exemption must not authenticate it — the attacker's mail-example.com key
    // produces the same 'mail-example-com' label.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@mail-example-com.20251104.gappssmtp.com'),
        'user@mail.example.com',
      ),
    ).toBe(false);
    // A hyphenated victim domain is likewise ambiguous and refused.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.i=@my-corp-com.20251104.gappssmtp.com'),
        'owner@my-corp.com',
      ),
    ).toBe(false);
  });

  it('rejects unverified, misaligned, and sender-supplied authentication claims', () => {
    expect(gmailSenderAuthenticated(undefined, 'owner@example.com')).toBe(false);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dmarc=pass header.from=attacker.example'),
        'owner@example.com',
      ),
    ).toBe(false);
    expect(
      gmailSenderAuthenticated(
        payload('attacker.example; dmarc=pass header.from=example.com'),
        'owner@example.com',
      ),
    ).toBe(false);
  });

  it('accepts relaxed DKIM/SPF organizational alignment for subdomain senders', () => {
    // Very common: a careers portal at jobs.company.com signs DKIM with the
    // organizational domain company.com. Strict-only alignment dropped these.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.d=company.com header.s=sel'),
        'careers@jobs.company.com',
      ),
    ).toBe(true);
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; spf=pass smtp.mailfrom=bounce.company.com'),
        'careers@company.com',
      ),
    ).toBe(true);
  });

  it('does not relax alignment across different orgs or for DMARC', () => {
    // Different second-level domains must never align, even sharing a suffix.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.d=attacker.com header.s=sel'),
        'careers@company.com',
      ),
    ).toBe(false);
    // Two orgs under a shared public suffix are not a subdomain relationship.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dkim=pass header.d=attacker.co.uk header.s=sel'),
        'user@victim.co.uk',
      ),
    ).toBe(false);
    // DMARC stays strict: relaxed subdomain alignment must not apply to it.
    expect(
      gmailSenderAuthenticated(
        payload('mx.google.com; dmarc=pass header.from=company.com'),
        'careers@jobs.company.com',
      ),
    ).toBe(false);
  });

  it('does not let a sender forge a pass clause inside an SPF comment or quoted mailfrom', () => {
    // The attacker uses an RFC-5321-legal quoted local part in MAIL FROM so
    // Gmail echoes attacker-controlled text — carrying a ';' and a synthetic
    // 'dkim=pass header.d=<owner>' — into the SPF clause. A naive split on ';'
    // would mint that clause and authenticate the spoof.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com; spf=softfail (google.com: domain of "; dkim=pass header.d=example.com "@evil.test does not designate) smtp.mailfrom="; dkim=pass header.d=example.com "@evil.test',
        ),
        'owner@example.com',
      ),
    ).toBe(false);
    // The same smuggling attempt via a nested comment must also fail.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com; spf=none (a (b; dkim=pass header.d=example.com) c) smtp.mailfrom=x@evil.test',
        ),
        'owner@example.com',
      ),
    ).toBe(false);
    // A genuine comment in a legitimate header does not break real authentication.
    expect(
      gmailSenderAuthenticated(
        payload(
          'mx.google.com; spf=pass (google.com: domain of owner@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=owner@example.com; dmarc=pass (p=reject) header.from=example.com',
        ),
        'owner@example.com',
      ),
    ).toBe(true);
  });

  it('reads only the topmost Authentication-Results header (S6)', () => {
    const multi = (values: string[]) => ({
      headers: values.map((value) => ({ name: 'Authentication-Results', value })),
    });
    // Gmail prepends its own verdict at delivery, so the receiver header is
    // first. A sender-injected forged mx.google.com header lower in the list
    // must never authenticate.
    expect(
      gmailSenderAuthenticated(
        multi([
          'mx.google.com; dmarc=fail header.from=example.com',
          'mx.google.com; dmarc=pass header.from=example.com',
        ]),
        'owner@example.com',
      ),
    ).toBe(false);
    // The genuine (top) Gmail header still authenticates even when a stale
    // sender-supplied header sits beneath it.
    expect(
      gmailSenderAuthenticated(
        multi([
          'mx.google.com; dmarc=pass header.from=example.com',
          'mx.google.com; dmarc=fail header.from=example.com',
        ]),
        'owner@example.com',
      ),
    ).toBe(true);
    // A non-Google top header is not trusted, and we do NOT fall through to a
    // lower forged Google header.
    expect(
      gmailSenderAuthenticated(
        multi([
          'attacker.example; dmarc=pass header.from=example.com',
          'mx.google.com; dmarc=pass header.from=example.com',
        ]),
        'owner@example.com',
      ),
    ).toBe(false);
  });
});

describe('forwarded-ingest owner alerts', () => {
  it('composes an SMS-safe three-line heads-up', () => {
    const text = importantEmailNotice('alice@example.com', 'Q3 invoice', {
      category: 'financial',
      importance: 5,
      reason: 'Payment due Friday.',
      dates: [{ iso: '2026-08-28', what: 'payment due' }],
    });
    expect(text).toContain('Important email from alice@example.com');
    expect(text).toContain('Q3 invoice');
    expect(text).toContain('Payment due Friday.');
    expect(text).toContain('payment due (2026-08-28)');
  });

  it('pings the owner at or above the notify threshold, stays quiet below it', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const stamp = `${Date.now()}`;
    const conversationIds: string[] = [];
    const run = async (importance: number) => {
      const notified: string[] = [];
      const deps = {
        config: {
          ASSISTANT_MODULES: [] as never[],
          EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
          EMAIL_INGEST_NOTIFY_THRESHOLD: 4,
          EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
        },
        db,
        router: {
          object: async () => ({
            ok: true,
            object: {
              category: 'financial',
              importance,
              actionable: true,
              dates: [],
              reason: 'A payment is due.',
            },
          }),
        },
        workspace: {},
        googleClient: { configured: () => false, api: async () => ({}) },
        notifyOwner: async ({ text }: { text: string }) => {
          notified.push(text);
        },
        observeInboundEmail: async () => {},
      } as unknown as EmailSyncDeps;

      const channelMessageId = `gmail:xtest-notify-${stamp}-${importance}`;
      const outcome = await processForwardedIngest(deps, {
        agentId,
        message: { id: `m-${stamp}-${importance}`, threadId: `t-${stamp}-${importance}` },
        from: 'alice@example.com',
        subject: `Invoice ${importance}`,
        text: 'Please pay the attached invoice by Friday.',
        rfcMessageId: '',
        authenticated: true,
        contactTrustByEmail: new Map(),
        channelMessageId,
      });
      const [row] = await db
        .select({ conversationId: emailIngest.conversationId })
        .from(emailIngest)
        .where(eq(emailIngest.channelMessageId, channelMessageId));
      if (row?.conversationId) conversationIds.push(row.conversationId);
      return { outcome, notified };
    };

    try {
      const high = await run(5);
      expect(high.outcome).toBe('triaged');
      expect(high.notified).toHaveLength(1);
      expect(high.notified[0]).toContain('alice@example.com');

      const low = await run(2);
      expect(low.outcome).toBe('skipped');
      expect(low.notified).toHaveLength(0);
    } finally {
      if (conversationIds.length > 0) {
        await db.delete(tasks).where(inArray(tasks.conversationId, conversationIds));
        await db.delete(emailIngest).where(inArray(emailIngest.conversationId, conversationIds));
        await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
        await db
          .delete(channelBindings)
          .where(inArray(channelBindings.conversationId, conversationIds));
        await db.delete(conversations).where(inArray(conversations.id, conversationIds));
      }
    }
  });
});
