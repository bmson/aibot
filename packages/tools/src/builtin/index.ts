import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  conversations,
  goals,
  isTombstoned,
  memories,
  messages,
  resolveSubjectContact,
  tasks,
} from '@assistant/db';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
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

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
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
      description: 'Recall memories relevant to a query (semantic similarity).',
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
        return { memories: rows };
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
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
        let conversationId = ctx.conversationId;
        if (!conversationId) {
          const [existing] = await ctx.db
            .select()
            .from(conversations)
            .where(
              and(eq(conversations.agentId, ctx.agentId), eq(conversations.title, 'Notifications')),
            );
          if (existing) {
            conversationId = existing.id;
          } else {
            const [created] = await ctx.db
              .insert(conversations)
              .values({
                agentId: ctx.agentId,
                channel: 'chat',
                trust: 'assistant',
                title: 'Notifications',
              })
              .returning();
            conversationId = created?.id;
          }
        }
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
    { outwardFacing: true },
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
          trigger: { source: 'internal', payload: { instruction: args.instruction } },
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
    acceptsUntrustedInput: false,
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
    acceptsUntrustedInput: false,
    execute: async (args, ctx) => {
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
      approvalSummary: (args) => `Create goal "${(args as { title: string }).title}"`,
      execute: async (args, ctx) => {
        const [row] = await ctx.db
          .insert(goals)
          .values({
            agentId: ctx.agentId,
            title: args.title,
            description: args.description,
            priority: args.priority,
            targetDate: args.targetDate ? new Date(args.targetDate) : undefined,
          })
          .returning();
        return { goalId: row?.id, title: args.title };
      },
    },
    { outwardFacing: false },
  );

  return registry;
}
