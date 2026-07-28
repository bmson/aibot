import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  getOrCreateNotificationsConversation,
  saveOccasion,
  upcomingOccasions,
} from '@assistant/core';
import {
  findContactsByName,
  goals,
  isTombstoned,
  memories,
  messages,
  resolveSubjectContact,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';
import type { WorkspaceStore } from '../workspace-store.js';

export interface BuiltinDeps {
  /** Embedding closure (injected by the app — avoids a core↔tools cycle). */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Workspace file store: local FS in dev, GCS in prod. */
  workspace: WorkspaceStore;
}

export const WEB_FETCH_MAX_BYTES = 256 * 1024;
const WEB_FETCH_MAX_REDIRECTS = 5;
const WEB_DNS_TIMEOUT_MS = 5_000;

export interface ResolvedWebAddress {
  address: string;
  family: 4 | 6;
}

export interface WebFetchResponse {
  status: number;
  headers: {
    contentType: string;
    contentEncoding: string;
    location?: string;
  };
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
}

export interface WebFetchIo {
  resolve: (hostname: string) => Promise<ResolvedWebAddress[]>;
  get: (url: URL, address: ResolvedWebAddress, signal: AbortSignal) => Promise<WebFetchResponse>;
}

function ipv4Octets(address: string): number[] | null {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets;
}

function ipv6Words(rawAddress: string): number[] | null {
  let address =
    rawAddress
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%', 1)[0] ?? '';
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const octets = ipv4Octets(address.slice(lastColon + 1));
    if (lastColon < 0 || !octets) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const words = half.split(':').map((word) => Number.parseInt(word, 16));
    return words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
      ? null
      : words;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const zeroCount = 8 - left.length - right.length;
  if ((halves.length === 1 && zeroCount !== 0) || (halves.length === 2 && zeroCount < 1)) {
    return null;
  }
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

/** Only globally routable addresses may be contacted by web.fetch. */
export function isPublicIpAddress(rawAddress: string): boolean {
  const address = rawAddress.replace(/^\[|\]$/g, '').split('%', 1)[0] ?? '';
  const family = isIP(address);
  if (family === 4) {
    const octets = ipv4Octets(address);
    if (!octets) return false;
    const [a = 0, b = 0, c = 0] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;

  const words = ipv6Words(address);
  if (!words) return false;
  // IPv4-mapped IPv6 must inherit the embedded IPv4 address's classification.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return isPublicIpAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  const [first = 0, second = 0, third = 0] = words;
  if ((first & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3
  if (first === 0x2002) return false; // 6to4 can tunnel to private IPv4
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2001 && second === 0) return false; // Teredo/special-purpose
  if (first === 0x2001 && second === 2 && third === 0) return false; // benchmarking
  if (first === 0x2001 && ((second & 0xfff0) === 0x10 || (second & 0xfff0) === 0x20)) {
    return false; // ORCHID identifier ranges
  }
  return true;
}

async function nodeResolve(hostname: string): Promise<ResolvedWebAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  let rows: Array<{ address: string; family: number }>;
  try {
    rows = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }) as Promise<
        Array<{ address: string; family: number }>
      >,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS resolution timed out')), WEB_DNS_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return rows.flatMap((row) =>
    row.family === 4 || row.family === 6 ? [{ address: row.address, family: row.family }] : [],
  );
}

async function nodeGet(
  url: URL,
  address: ResolvedWebAddress,
  signal: AbortSignal,
): Promise<WebFetchResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const lookup = ((_hostname, _options, callback) => {
      callback(null, address.address, address.family);
    }) as LookupFunction;
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        family: address.family,
        lookup,
        signal,
        headers: {
          accept: 'text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'assistant-bot/0.1 (+personal use)',
        },
      },
      (response) => {
        const firstHeader = (value: string | string[] | undefined): string =>
          Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            contentType: firstHeader(response.headers['content-type']),
            contentEncoding: firstHeader(response.headers['content-encoding']),
            location: firstHeader(response.headers.location) || undefined,
          },
          body: response,
          cancel: () => response.destroy(),
        });
      },
    );
    req.once('error', reject);
    req.end();
  });
}

const DEFAULT_WEB_FETCH_IO: WebFetchIo = { resolve: nodeResolve, get: nodeGet };

function validateWebUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('http(s) only');
  if (url.username || url.password) throw new Error('URL credentials are blocked');
  if (!url.hostname) throw new Error('URL hostname is required');
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) throw new Error('non-standard web ports are blocked');
}

async function resolvePublicAddress(url: URL, io: WebFetchIo): Promise<ResolvedWebAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await io.resolve(hostname);
  if (addresses.length === 0) throw new Error('hostname did not resolve');
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('private or non-routable addresses are blocked');
  }
  return addresses[0] as ResolvedWebAddress;
}

async function readBoundedBody(
  response: WebFetchResponse,
): Promise<{ body: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let truncated = false;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    const remaining = WEB_FETCH_MAX_BYTES - bytesRead;
    if (bytes.length > remaining) {
      if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
      bytesRead += Math.max(remaining, 0);
      truncated = true;
      response.cancel();
      break;
    }
    chunks.push(bytes);
    bytesRead += bytes.length;
  }
  return { body: Buffer.concat(chunks, bytesRead).toString('utf8'), truncated };
}

/** Fetch with DNS validation, IP pinning, manual redirect checks, and a byte cap. */
export async function fetchPublicWebPage(
  rawUrl: string,
  signal: AbortSignal,
  io: WebFetchIo = DEFAULT_WEB_FETCH_IO,
): Promise<{
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  finalUrl: string;
}> {
  let url = new URL(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    validateWebUrl(url);
    const address = await resolvePublicAddress(url, io);
    signal.throwIfAborted();
    const response = await io.get(url, address, signal);
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    if (isRedirect && response.headers.location) {
      response.cancel();
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) throw new Error('too many redirects');
      url = new URL(response.headers.location, url);
      continue;
    }
    const encoding = response.headers.contentEncoding.trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      response.cancel();
      throw new Error('compressed responses are blocked');
    }
    const { body, truncated } = await readBoundedBody(response);
    return {
      status: response.status,
      contentType: response.headers.contentType,
      body,
      truncated,
      finalUrl: url.toString(),
    };
  }
}

/**
 * Bot-challenge detector for web.fetch. Search engines and Cloudflare-fronted
 * sites answer datacenter traffic with a small verification page instead of
 * content — DuckDuckGo even serves its CAPTCHA as HTTP 202, so neither the
 * status code nor "we got HTML" distinguishes a wall from an answer. Treating
 * a challenge as a successful fetch poisons everything downstream: the model
 * summarizes a CAPTCHA page as if it were content, and an unattended goal
 * session counts the fetch as verified work (exactly that burned a goal
 * session's budget in prod). Phrases are only matched near the top of the
 * page, and only when the response also has a challenge-ish status or is
 * suspiciously small, so an article ABOUT captchas does not trip it.
 */
export function looksLikeBotChallenge(status: number, text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  const phrase =
    /complete the following challenge|verify (that )?you('re| are) (a )?human|are you a robot|enable javascript and cookies to continue|additional verification required|checking your browser|just a moment/;
  if (!phrase.test(head)) return false;
  const challengeStatus = status === 202 || status === 403 || status === 429 || status === 503;
  return challengeStatus || text.length < 4000;
}

export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinDeps): ToolRegistry {
  // ── memory ─────────────────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'memory.save',
      description:
        'Save a durable memory. category "knowledge" for lasting facts/preferences/people; "experience" for what happened during work (expires eventually). Attribute facts about a person via subject ("owner" for the owner, else their name).',
      inputSchema: z.object({
        content: z.string().min(3).max(2000),
        category: z.enum(['knowledge', 'experience']),
        kind: z.enum(['fact', 'preference', 'person', 'project', 'episode']),
        subject: z
          .string()
          .max(120)
          .default('')
          .describe('Who the fact is about: "owner", a person\'s name, or empty if about no one.'),
        domain: z
          .enum(['identity', 'work', 'home', 'relationships', 'preferences', 'health', 'other'])
          .optional(),
        importance: z.number().int().min(1).max(5).default(3),
        confidence: z.number().min(0).max(1).default(0.7),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      // Shown when a tainted session tries to persist a memory (writesMemory
      // routes it to approval): the owner sees the exact text being stored.
      approvalSummary: (args) =>
        `Remember${args.subject ? ` (about ${args.subject})` : ''}: “${args.content.slice(0, 200)}”`,
      execute: async (args, ctx) => {
        const contentHash = createHash('sha256').update(args.content).digest('hex');
        if (await isTombstoned(ctx.db, contentHash)) {
          return {
            saved: false,
            tombstoned: true,
            note: 'the owner explicitly forgot this fact — do not re-save it',
          };
        }
        const [embedding] = await deps.embed([args.content]);
        const quarantined = ctx.trust !== 'owner' && ctx.trust !== 'assistant';
        const subject = args.subject
          ? await resolveSubjectContact(ctx.db, { subject: args.subject })
          : null;
        const expiresAt =
          args.category === 'experience' ? new Date(Date.now() + 90 * 24 * 3600 * 1000) : undefined;
        const [row] = await ctx.db
          .insert(memories)
          .values({
            agentId: ctx.agentId,
            category: args.category,
            kind: args.kind,
            content: args.content,
            contentHash,
            embedding,
            importance: args.importance,
            confidence: String(args.confidence),
            originTrust: ctx.trust,
            quarantined,
            subjectContactId: subject?.contactId,
            domain: args.domain,
            sourceTaskId: ctx.taskId,
            expiresAt,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning();
        return { saved: Boolean(row), duplicate: !row, quarantined };
      },
    },
    { writesMemory: true },
  );

  register(
    registry,
    {
      name: 'memory.recall',
      description:
        'Recall memories relevant to a query (semantic similarity). Each result carries a confidence and, when known, a validity window. Treat a low-confidence or expired-validity fact as unconfirmed — verify or ask rather than acting on it as certain, especially for a name, date, address, or link.',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const [embedding] = await deps.embed([args.query]);
        const rows = await ctx.db
          .select({
            content: memories.content,
            category: memories.category,
            kind: memories.kind,
            importance: memories.importance,
            confidence: memories.confidence,
            validFrom: memories.validFrom,
            validUntil: memories.validUntil,
            createdAt: memories.createdAt,
            similarity: sql<number>`1 - (${memories.embedding} <=> ${JSON.stringify(embedding)}::vector)`,
          })
          .from(memories)
          .where(
            and(
              eq(memories.agentId, ctx.agentId),
              eq(memories.quarantined, false),
              or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
            ),
          )
          .orderBy(sql`${memories.embedding} <=> ${JSON.stringify(embedding)}::vector`)
          .limit(args.limit);
        const now = Date.now();
        return {
          memories: rows.map((r) => ({
            ...r,
            // Flag a fact the model must not treat as settled: low confidence, or
            // a validity window that has lapsed (stale but not yet superseded).
            unconfirmed:
              Number(r.confidence) < 0.5 ||
              (r.validUntil ? new Date(r.validUntil).getTime() < now : false),
          })),
        };
      },
    },
    // Recall filters quarantined rows, and untrusted-origin facts are
    // quarantined at write time (extraction) — so what recall returns is
    // owner-vetted state. Grounding a task in its own memory must not strip
    // the owner card from every later step.
    { confidentialRead: true },
  );

  // ── truncated-result paging ─────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'tools.read_result',
      description:
        'Read more of a truncated tool result. When a result says "truncated" and names a toolCallId, call this with that id and the suggested offset to page through the full stored result. Only results from the current task are readable.',
      inputSchema: z.object({
        toolCallId: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        // Scoped to the calling task: other tasks' results may hold content
        // this task's trust tier was never meant to see.
        const [row] = await ctx.db
          .select({ result: toolCalls.result, taskId: toolCalls.taskId })
          .from(toolCalls)
          .where(eq(toolCalls.id, args.toolCallId));
        if (!row || row.taskId !== ctx.taskId) {
          return { error: 'no such tool call in this task' };
        }
        const json = JSON.stringify(row.result ?? null);
        const chunk = json.slice(args.offset, args.offset + 30_000);
        return {
          totalChars: json.length,
          offset: args.offset,
          chunk,
          hasMore: args.offset + chunk.length < json.length,
        };
      },
    },
    // The stored result may embed third-party content (a fetched page, a mail
    // thread), so reading it re-taints exactly like the original tool did.
    { returnsUntrustedContent: true },
  );

  // ── occasions (Phase 17) ─────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'occasions.save',
      description:
        "Record a recurring date for one of the owner's people — a birthday, anniversary, or custom occasion — so it can be surfaced at lead time. Give the person by name (subject), the month and day; year and gift-idea notes are optional. Re-saving the same date merges new notes and fills in a missing year.",
      inputSchema: z.object({
        subject: z.string().min(1).max(120).describe("The person's name this occasion is about."),
        kind: z.enum(['birthday', 'anniversary', 'custom']),
        label: z
          .string()
          .max(120)
          .default('')
          .describe('For a custom occasion, what it is (e.g. "graduation").'),
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
        year: z.number().int().min(1900).max(2200).optional(),
        leadDays: z.number().int().min(0).max(60).default(7),
        notes: z
          .string()
          .max(2000)
          .default('')
          .describe('Gift ideas or context for this occasion.'),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      approvalSummary: (args) =>
        `Remember ${args.subject}'s ${
          args.kind === 'custom' ? args.label || 'occasion' : args.kind
        } on ${args.month}/${args.day}`,
      execute: async (args, ctx) => {
        const resolved = await resolveSubjectContact(ctx.db, { subject: args.subject });
        if (!resolved) {
          return { saved: false, note: 'could not resolve who this occasion is about' };
        }
        // Untrusted sessions store the occasion quarantined, exactly like memory.save.
        const quarantined = ctx.trust !== 'owner' && ctx.trust !== 'assistant';
        const result = await saveOccasion(ctx.db, {
          agentId: ctx.agentId,
          contactId: resolved.contactId,
          kind: args.kind,
          label: args.label,
          month: args.month,
          day: args.day,
          year: args.year ?? null,
          leadDays: args.leadDays,
          notes: args.notes,
          originTrust: ctx.trust,
          quarantined,
          source: 'occasions.save',
        });
        return { saved: result.saved, updated: !result.saved, quarantined, person: args.subject };
      },
    },
    { writesMemory: true },
  );

  register(
    registry,
    {
      name: 'occasions.list',
      description:
        "List the owner's people's upcoming occasions (birthdays, anniversaries, custom dates), soonest first. Use this to answer 'whose birthday is coming up?' or, together with memory.recall, 'what should I get them?'.",
      inputSchema: z.object({
        withinDays: z
          .number()
          .int()
          .min(1)
          .max(366)
          .default(30)
          .describe('How far ahead to look, in days.'),
      }),
      risk: 'autonomous',
      // Occasion + contact fields are owner/assistant-authored reference data
      // (quarantined ones never surface here), so — like goals.list — this is a
      // confidential read but NOT untrusted content.
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const upcoming = await upcomingOccasions(ctx.db, ctx.agentId, {
          withinDays: args.withinDays,
        });
        return {
          occasions: upcoming.map((o) => ({
            person: o.contactName,
            kind: o.kind === 'custom' ? o.label || 'occasion' : o.kind,
            date: o.nextDate,
            daysUntil: o.daysUntil,
            notes: o.notes || undefined,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  // ── contacts ─────────────────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'contacts.lookup',
      description:
        "Resolve a person's saved email address(es) and phone number(s) by name BEFORE emailing or texting them. Returns only matching saved contacts. If it returns no contact (or no address for the person), you do NOT know how to reach them — ask the owner instead of guessing an address. Never invent a recipient.",
      inputSchema: z.object({
        name: z
          .string()
          .min(2)
          .max(120)
          .describe('The person to look up, e.g. "Anna" or "Dr. Smith".'),
      }),
      risk: 'autonomous',
      // Owner-curated identifier rows, sanitized below to email/phone/name only
      // — NOT free third-party prose. Unlike memory.recall this deliberately does
      // NOT set returnsUntrustedContent, so resolving an address never taints the
      // session or forfeits a goal session's one autonomous outward action.
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const matches = await findContactsByName(ctx.db, args.name);
        return {
          query: args.name,
          contacts: matches.map((c) => ({
            name: c.name,
            emails: c.emails.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 5),
            phones: c.phones.filter((p) => /^\+?\d[\d\s().-]{5,}$/.test(p)).slice(0, 5),
            relationship: c.relationship || undefined,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  // ── web ────────────────────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'web.fetch',
      description:
        'Fetch a public web page over HTTP GET and return its text content. For reading only — no forms, no logins.',
      inputSchema: z.object({ url: z.string().url() }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      // Shown when a tainted session tries to fetch (networkEgress routes it to
      // approval): the exact URL matters because a fetch to an attacker URL is
      // itself the egress/exfiltration channel.
      approvalSummary: (args) => `Fetch the public web page ${args.url}`,
      cacheTtlSeconds: 900,
      execute: async (args, ctx) => {
        const fetched = await fetchPublicWebPage(
          args.url,
          AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
        );
        // crude extraction v1: strip tags/scripts; a real readability pass comes with the browser phase
        const text = fetched.contentType.includes('html')
          ? fetched.body
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
          : fetched.body;
        if (looksLikeBotChallenge(fetched.status, text)) {
          throw new Error(
            `bot-challenge wall instead of content: ${fetched.finalUrl} answered HTTP ${fetched.status} with a CAPTCHA/verification page. ` +
              'This site blocks automated fetches — do not retry this URL; go to a different source (the target site directly, its API or RSS feed).',
          );
        }
        return {
          status: fetched.status,
          contentType: fetched.contentType,
          text: text.slice(0, 20000),
          truncated: fetched.truncated || text.length > 20000,
          finalUrl: fetched.finalUrl,
        };
      },
    },
    {
      returnsUntrustedContent: true,
      networkEgress: true,
      blanketAllowIneligible: true,
    },
  );

  // ── workspace files ────────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'workspace.write',
      description: "Write a text file into the assistant's workspace.",
      inputSchema: z.object({
        path: z.string().min(1).max(300),
        content: z.string().max(200_000),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const { bytes } = await deps.workspace.write(args.path, args.content);
        return { written: args.path, bytes };
      },
    },
    { writesWorkspace: true },
  );

  register(
    registry,
    {
      name: 'workspace.read',
      description: "Read a text file from the assistant's workspace.",
      inputSchema: z.object({ path: z.string().min(1).max(300) }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const content = await deps.workspace.read(args.path);
        return { path: args.path, content: content.slice(0, 100_000) };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  register(
    registry,
    {
      name: 'workspace.list',
      description: 'List files in a workspace directory.',
      inputSchema: z.object({ path: z.string().max(300).default('.') }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args) => {
        const entries = await deps.workspace.list(args.path || '.');
        return { entries };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  // ── conversation search ────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'conversations.search',
      description: 'Search past conversations semantically ("where did we discuss X").',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const [embedding] = await deps.embed([args.query]);
        const withEmbedding = await ctx.db
          .select({
            conversationId: messages.conversationId,
            text: messages.text,
            createdAt: messages.createdAt,
            similarity: sql<number>`1 - (${messages.embedding} <=> ${JSON.stringify(embedding)}::vector)`,
          })
          .from(messages)
          .where(sql`${messages.embedding} IS NOT NULL`)
          .orderBy(sql`${messages.embedding} <=> ${JSON.stringify(embedding)}::vector`)
          .limit(args.limit);
        if (withEmbedding.length > 0) return { matches: withEmbedding, mode: 'semantic' };

        const fallback = await ctx.db
          .select({
            conversationId: messages.conversationId,
            text: messages.text,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(sql`${messages.text} ILIKE ${`%${args.query}%`}`)
          .orderBy(desc(messages.createdAt))
          .limit(args.limit);
        return { matches: fallback, mode: 'text' };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );

  // ── owner notification ─────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'owner.notify',
      description:
        'Leave a message for the owner. It appears in the current conversation (or the Notifications conversation) and on the dashboard.',
      inputSchema: z.object({ message: z.string().min(1).max(4000) }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const conversationId =
          ctx.conversationId ?? (await getOrCreateNotificationsConversation(ctx.db, ctx.agentId));
        if (!conversationId) throw new Error('no conversation available for notification');
        await ctx.db.insert(messages).values({
          conversationId,
          taskId: ctx.taskId,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: args.message }],
          text: args.message,
        });
        return { notified: true, conversationId };
      },
    },
    // Sink is hardwired to the owner's own conversation (ctx.conversationId) or
    // the assistant-owned 'Notifications' thread — never a third party or the
    // network. ownerVisibleOnly keeps it autonomous under taint (D6): the model
    // relaying content into the owner's own dashboard is no more capable than
    // its ordinary reply text. acceptsUntrustedInput:false still strips it from
    // every external (known/unknown) task registry.
    { ownerVisibleOnly: true },
  );

  // ── future self-tasks ──────────────────────────────────────────────────────
  register(registry, {
    name: 'task.schedule',
    description:
      'Defer work: schedule a future task for YOURSELF to run later (e.g. "check back on this thread tomorrow"). NOT for calendar events — calendar entries are created with calendar.create_event immediately, even when the event is in the future. when is an ISO 8601 timestamp.',
    inputSchema: z.object({
      when: z.string().datetime({ offset: true }),
      instruction: z.string().min(3).max(2000),
    }),
    risk: 'autonomous',
    acceptsUntrustedInput: false,
    // The scheduling step is itself gated under taint (acceptsUntrustedInput:false),
    // so the owner sees this card. Make the card show WHAT is being scheduled —
    // a generic "schedule follow-up work" would let an injected instruction ride
    // through an approval the owner cannot actually inspect.
    approvalSummary: (args) => {
      const when = new Date(args.when);
      const at = Number.isNaN(when.getTime()) ? args.when : when.toISOString();
      return `Schedule a future task for ${at}: “${args.instruction.slice(0, 200)}”`;
    },
    execute: async (args, ctx) => {
      const runAfter = new Date(args.when);
      if (Number.isNaN(runAfter.getTime())) throw new Error('invalid timestamp');
      if (runAfter.getTime() < Date.now()) throw new Error('when must be in the future');

      const [count] = await ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, ctx.taskId), eq(tasks.status, 'sleeping')));
      if (Number(count?.n ?? 0) >= 5) throw new Error('too many scheduled follow-ups (max 5)');

      const [task] = await ctx.db
        .insert(tasks)
        .values({
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
          type: 'scheduled',
          status: 'sleeping',
          trust: ctx.trust === 'owner' ? 'owner' : 'assistant',
          // Taint laundering defense: a scheduled child of a tainted session
          // would otherwise start clean (shouldTaintContext only taints
          // source==='email'), and its instruction — possibly lifted from
          // attacker content — becomes the opening user turn. Carry the taint
          // forward so the child's outward/egress calls stay approval-gated.
          trigger: {
            source: 'internal',
            payload: {
              instruction: args.instruction,
              ...(ctx.tainted ? { taintedOrigin: true } : {}),
            },
          },
          runAfter,
          parentTaskId: ctx.taskId,
        })
        .returning();
      return { scheduled: Boolean(task), taskId: task?.id, runAfter: args.when };
    },
  });

  // ── missions & goals ───────────────────────────────────────────────────────
  register(registry, {
    name: 'mission.update',
    description:
      'Update your parent mission after a work session: progress summary, next action, optional percent, and notes for the next session. Call this before finishing a mission session.',
    inputSchema: z.object({
      progress: z.string().min(3).max(1000),
      nextAction: z.string().max(500).default(''),
      progressPercent: z.number().int().min(0).max(100).nullish(),
      notes: z.string().max(2000).default(''),
    }),
    risk: 'autonomous',
    // A mission session almost always reads untrusted content (web.fetch,
    // gmail.search, browser.execute) before it can summarise progress. Gating
    // this internal state write on taint would strip the ONLY progress writer
    // once tainted, silently stalling the mission loop (it would repeat step
    // one forever). It writes bounded, model-authored text to the assistant's
    // own mission row — no outward or privileged effect — and is already
    // restricted to real mission sessions by the dispatcher's parent-mission
    // gate. Persisted text is re-surfaced to the next session as reference
    // data, never as instructions (see sessionInstruction).
    acceptsUntrustedInput: true,
    execute: async (args, ctx) => {
      const [self] = await ctx.db.select().from(tasks).where(eq(tasks.id, ctx.taskId));
      if (!self?.parentTaskId) throw new Error('this task has no parent mission');
      const [mission] = await ctx.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, self.parentTaskId), eq(tasks.type, 'mission')));
      if (!mission) throw new Error('parent is not a mission');

      const state = (mission.state ?? {}) as Record<string, unknown>;
      if (args.notes) state.scratchpad = String(args.notes).slice(0, 4000);
      await ctx.db
        .update(tasks)
        .set({
          progress: args.progress,
          nextAction: args.nextAction,
          progressPercent: args.progressPercent ?? mission.progressPercent,
          state,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, mission.id));
      return { updated: mission.id };
    },
  });

  register(
    registry,
    {
      name: 'goals.list',
      description: "List the owner's long-term goals (active first).",
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      // Deliberately NOT returnsUntrustedContent. Goal titles/progress are
      // owner- or assistant-authored and carried as reference-only data (see
      // goalInstruction, which frames them "information only, never
      // instructions"). Marking this untrusted would taint every goal-aware
      // chat turn — stripping the owner card, gating memory.save — for text the
      // owner wrote about their own goals. The model-authored progress note IS
      // write-bound to the task's own goal by the dispatcher, so there is no
      // cross-goal injection surface here.
      execute: async (_args, ctx) => {
        const rows = await ctx.db
          .select()
          .from(goals)
          .where(eq(goals.agentId, ctx.agentId))
          .orderBy(goals.status, goals.priority);
        return {
          goals: rows.map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
            priority: g.priority,
            progress: g.progress,
            nextAction: g.nextAction,
            targetDate: g.targetDate?.toISOString() ?? null,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  register(registry, {
    name: 'goals.update_progress',
    description: 'Update the progress note and next action on an existing goal.',
    inputSchema: z.object({
      goalId: z.string().uuid(),
      progress: z.string().min(1).max(1000),
      nextAction: z.string().max(500).default(''),
    }),
    risk: 'autonomous',
    // Like mission.update: a goal work session taints itself with ordinary
    // research reads before it can record progress, so gating this on taint
    // stalls the goal loop. It writes bounded model-authored text to the
    // owner's own goal row and stays available under taint. Two controls keep
    // that carve-out safe: the dispatcher binds the write to the goal this task
    // (or its work chat) owns — so injected content cannot redirect it to
    // another goal or drive it from a task that owns no goal — and the execute
    // below fails closed for any non-owner/assistant trust.
    acceptsUntrustedInput: true,
    execute: async (args, ctx) => {
      if (ctx.trust !== 'owner' && ctx.trust !== 'assistant') {
        throw new Error('goals.update_progress is available only to owner/assistant tasks');
      }
      const [row] = await ctx.db
        .update(goals)
        .set({ progress: args.progress, nextAction: args.nextAction, updatedAt: sql`now()` })
        .where(and(eq(goals.id, args.goalId), eq(goals.agentId, ctx.agentId)))
        .returning();
      if (!row) throw new Error('goal not found');
      return { updated: row.id, title: row.title };
    },
  });

  register(
    registry,
    {
      name: 'goals.create',
      description:
        'Create a new long-term goal for the owner. Requires owner approval — goals shape long-running behavior.',
      inputSchema: z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2000).default(''),
        priority: z.number().int().min(1).max(5).default(3),
        targetDate: z.string().datetime({ offset: true }).optional(),
      }),
      risk: 'approval',
      acceptsUntrustedInput: false,
      // The description (up to 2000 chars) becomes the recurring automation's
      // standing instruction, so the owner must see it on the approval card —
      // a title-only summary would let an injected instruction ride through an
      // approval the owner cannot actually inspect.
      approvalSummary: (args) => {
        const a = args as { title: string; description?: string };
        const desc = a.description?.trim();
        return `Create goal "${a.title}"${desc ? ` — ${desc.slice(0, 300)}` : ''}`;
      },
      execute: async (args, ctx) => {
        const [row] = await ctx.db
          .insert(goals)
          .values({
            agentId: ctx.agentId,
            title: args.title,
            description: args.description,
            priority: args.priority,
            targetDate: args.targetDate ? new Date(args.targetDate) : undefined,
            // A goal proposed from a tainted session carries its provenance so
            // its automation sessions run taint-gated (see goals.taintedOrigin).
            taintedOrigin: ctx.tainted,
          })
          .returning();
        return { goalId: row?.id, title: args.title };
      },
    },
    // writesMemory: a goal is durable, behavior-shaping owner state that spawns a
    // recurring autonomous runner — treat it like a memory write, so it is
    // taint-gated and never one-tap SMS-approvable (a spoofed SMS must not be
    // able to plant a persistent autonomous-loop goal).
    { outwardFacing: false, writesMemory: true },
  );

  return registry;
}
