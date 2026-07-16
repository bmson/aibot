import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { conversations, goals, memories, messages, tasks } from '@assistant/db';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';

export interface BuiltinDeps {
  /** Embedding closure (injected by the app — avoids a core↔tools cycle). */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Local workspace root for FILES_DRIVER=local (GCS driver arrives with deploy). */
  workspaceDir: string;
}

const PRIVATE_HOST_PATTERN =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1)/i;

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

/** Resolve a workspace-relative path, refusing traversal outside the root. */
function safeWorkspacePath(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new Error('path escapes the workspace');
  }
  return resolved;
}

export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinDeps): ToolRegistry {
  // ── memory ─────────────────────────────────────────────────────────────────
  register(
    registry,
    {
      name: 'memory.save',
      description:
        'Save a durable memory. category "knowledge" for lasting facts/preferences/people; "experience" for what happened during work (expires eventually).',
      inputSchema: z.object({
        content: z.string().min(3).max(2000),
        category: z.enum(['knowledge', 'experience']),
        kind: z.enum(['fact', 'preference', 'person', 'project', 'episode']),
        importance: z.number().int().min(1).max(5).default(3),
        confidence: z.number().min(0).max(1).default(0.7),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const contentHash = createHash('sha256').update(args.content).digest('hex');
        const [embedding] = await deps.embed([args.content]);
        const quarantined = ctx.trust !== 'owner' && ctx.trust !== 'assistant';
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

  register(registry, {
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
  });

  // ── web ────────────────────────────────────────────────────────────────────
  register(registry, {
    name: 'web.fetch',
    description:
      'Fetch a public web page over HTTP GET and return its text content. For reading only — no forms, no logins.',
    inputSchema: z.object({ url: z.string().url() }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    cacheTtlSeconds: 900,
    execute: async (args, ctx) => {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http(s) only');
      if (PRIVATE_HOST_PATTERN.test(url.hostname)) throw new Error('private hosts are blocked');
      const res = await fetch(url, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
        headers: { 'user-agent': 'assistant-bot/0.1 (+personal use)' },
        redirect: 'follow',
      });
      const contentType = res.headers.get('content-type') ?? '';
      const body = await res.text();
      // crude extraction v1: strip tags/scripts; a real readability pass comes with the browser phase
      const text = contentType.includes('html')
        ? body
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : body;
      return { status: res.status, contentType, text: text.slice(0, 20000) };
    },
  });

  // ── workspace files ────────────────────────────────────────────────────────
  register(registry, {
    name: 'workspace.write',
    description: "Write a text file into the assistant's workspace.",
    inputSchema: z.object({
      path: z.string().min(1).max(300),
      content: z.string().max(200_000),
    }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args) => {
      const target = safeWorkspacePath(deps.workspaceDir, args.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, args.content, 'utf8');
      return { written: args.path, bytes: Buffer.byteLength(args.content) };
    },
  });

  register(registry, {
    name: 'workspace.read',
    description: "Read a text file from the assistant's workspace.",
    inputSchema: z.object({ path: z.string().min(1).max(300) }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args) => {
      const target = safeWorkspacePath(deps.workspaceDir, args.path);
      const content = await readFile(target, 'utf8');
      return { path: args.path, content: content.slice(0, 100_000) };
    },
  });

  register(registry, {
    name: 'workspace.list',
    description: 'List files in a workspace directory.',
    inputSchema: z.object({ path: z.string().max(300).default('.') }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async (args) => {
      const target = safeWorkspacePath(deps.workspaceDir, args.path || '.');
      const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
      return {
        entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })),
      };
    },
  });

  // ── conversation search ────────────────────────────────────────────────────
  register(registry, {
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
  });

  // ── owner notification ─────────────────────────────────────────────────────
  register(registry, {
    name: 'owner.notify',
    description:
      'Leave a message for the owner. It appears in the current conversation (or the Notifications conversation) and on the dashboard.',
    inputSchema: z.object({ message: z.string().min(1).max(4000) }),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
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
  });

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

  register(registry, {
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
  });

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
