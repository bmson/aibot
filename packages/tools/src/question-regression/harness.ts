import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  type AuditDefectKind,
  enqueueTask,
  executeTask,
  getAgent,
  gradeAuditedOutput,
  type ModelRouter,
} from '@assistant/core';
import {
  approvals,
  conversations,
  costEvents,
  type Db,
  messages,
  modelCalls,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ToolDispatcher } from '../dispatcher.js';
import { ToolRegistry } from '../registry.js';
import type { ToolFlags } from '../types.js';
import type { QuestionCase } from './corpus.js';

export function assertReplayDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/[a-zA-Z_][a-zA-Z0-9_]*_test$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Question replay requires a loopback PostgreSQL _test database without connection overrides.',
    );
  }
  return url.toString();
}

export interface QuestionResult {
  id: string;
  records: number[];
  mode: 'scripted' | 'live';
  status: string;
  answer: string;
  parts: unknown[];
  toolCalls: Array<{ name: string; status: string; args: unknown; result: unknown }>;
  approvals: number;
  saved: Array<{ subject: string; content: string }>;
  elapsedMs: number;
  costUsd: number;
  modelCalls: Array<{ role: string; model: string; latencyMs: number | null; costUsd: string }>;
  verification: unknown[];
  failures: string[];
}

/**
 * The defect kinds that make a *delivered answer* wrong to ship. Emptiness and
 * provider truncation are graded separately above, and emoji is suppressed
 * because these fixtures predate that rule — widening the suite's scope is a
 * separate decision from sharing its checks.
 */
const PRESENTATION_DEFECTS = new Set<AuditDefectKind>([
  'unclosed-code-fence',
  'background-notice-echo',
  'forbidden-theme-tag',
  'leaked-markup',
  'fabricated-interface-element',
  'excess-break-tags',
  'excess-chip-rows',
]);

export function evaluateQuestion(
  fixture: QuestionCase,
  result: Omit<QuestionResult, 'failures'>,
): string[] {
  const failures: string[] = [];
  const answer = result.answer;
  if (!answer.trim()) failures.push('answer: empty');
  for (const pattern of fixture.expect.matches)
    if (!new RegExp(pattern, 'is').test(answer)) failures.push(`answer: missing ${pattern}`);
  for (const pattern of fixture.expect.excludes ?? [])
    if (new RegExp(pattern, 'is').test(answer)) failures.push(`answer: forbidden ${pattern}`);
  for (const name of fixture.expect.tools ?? [])
    if (!result.toolCalls.some((call) => call.name === name && call.status === 'succeeded'))
      failures.push(`execution: missing successful ${name}`);
  for (const name of fixture.expect.failedTools ?? [])
    if (!result.toolCalls.some((call) => call.name === name && call.status === 'failed'))
      failures.push(`execution: missing failed ${name}`);
  if (fixture.expect.noTools && result.toolCalls.length)
    failures.push('execution: unexpected tool use');
  const expectedStatuses = fixture.expect.statuses ?? ['done'];
  if (!expectedStatuses.includes(result.status))
    failures.push(`completion: ${result.status}, expected ${expectedStatuses.join('|')}`);
  if (result.approvals > (fixture.expect.maxApprovals ?? 0))
    failures.push(`approvals: ${result.approvals} exceeds allowance`);
  if (fixture.expect.savedCount !== undefined && fixture.expect.savedCount !== result.saved.length)
    failures.push(`writes: saved ${result.saved.length}, expected ${fixture.expect.savedCount}`);
  const saved = result.saved.map((row) => `${row.subject}: ${row.content}`).join('\n');
  for (const text of fixture.expect.savedContent ?? [])
    if (!saved.toLowerCase().includes(text.toLowerCase())) failures.push(`writes: missing ${text}`);
  // The shared checks, not a local copy: these same functions now run in
  // `response-contract.ts` before publish, so a case can no longer fail here on
  // a property the runtime does not enforce — which is exactly what the
  // September audit found this suite doing.
  for (const defect of gradeAuditedOutput(answer, { emojiRequested: true }))
    if (PRESENTATION_DEFECTS.has(defect.kind))
      failures.push(`formatting: ${defect.kind} (${defect.detail})`);
  const cards = result.parts.flatMap((part) => {
    if (
      typeof part !== 'object' ||
      part === null ||
      !('type' in part) ||
      part.type !== 'data-card' ||
      !('data' in part)
    )
      return [];
    const data = part.data as {
      kind?: string;
      id?: string;
      revisionId?: string;
      spec?: { facts?: Array<{ value?: string }> };
    } | null;
    return data?.kind === 'generated-card' && data.id && data.revisionId ? [data] : [];
  });
  if (fixture.expect.card && !cards.length)
    failures.push('formatting: missing persisted generated card');
  const cardFacts = cards
    .flatMap((card) => card.spec?.facts?.map((fact) => fact.value ?? '') ?? [])
    .join(' ');
  for (const value of fixture.expect.cardValues ?? [])
    if (!cardFacts.includes(value)) failures.push(`formatting: card missing ${value}`);
  if (result.elapsedMs > 120_000) failures.push('performance: exceeded 120s');
  if (result.costUsd > 1.1) failures.push('performance: exceeded $1.10 per case');
  return failures;
}

/** No production adapters are imported. All tool bodies are local fixtures. */
function replayRegistry(
  fixture: QuestionCase,
  saved: Map<string, { subject: string; content: string }>,
): ToolRegistry {
  const registry = new ToolRegistry();
  function add(
    name: string,
    description: string,
    schema: z.ZodType,
    execute: (args: Record<string, unknown>) => unknown,
    flags: ToolFlags = {},
  ) {
    registry.register(
      {
        name,
        description,
        inputSchema: schema,
        risk: 'autonomous',
        acceptsUntrustedInput: !flags.writesMemory,
        execute: async (args) => execute(args as Record<string, unknown>),
      },
      flags,
    );
  }
  if (fixture.source) {
    const source = fixture.source;
    add(
      'web.search',
      'Search the public web for the requested question. Results contain source URLs; fetch a source to verify its facts.',
      z.object({ query: z.string(), count: z.number().optional() }),
      () => ({
        results: [
          { title: 'Source result', url: source.url, description: source.snippet ?? source.text },
        ],
      }),
      { networkEgress: true, returnsUntrustedContent: true },
    );
    add(
      'web.fetch',
      'Read the text of an exact source URL from search results.',
      z.object({ url: z.string().url() }),
      (args) => {
        if (args.url !== source.url)
          throw new Error('Replay has no captured response for this URL');
        if (source.failed) throw new Error('Captured provider failure: HTTP 503');
        return { url: source.url, status: 200, text: source.text };
      },
      { networkEgress: true, returnsUntrustedContent: true },
    );
  }
  if (fixture.weather)
    add(
      'weather.lookup',
      'Get current weather and forecast for the requested place.',
      z.object({
        place: z.string().optional(),
        days: z.number().optional(),
        date: z.string().optional(),
      }),
      () => {
        if (fixture.weather === 'failed') throw new Error('Captured weather failure: HTTP 400');
        return {
          place: 'San Francisco',
          usedCurrentLocation: false,
          current: {
            tempC: 18,
            description: 'Cloudy',
            highC: 20,
            lowC: 14,
            precipProbabilityMax: 10,
            windKmh: 12,
          },
          forecast: [
            {
              date: '2026-09-08',
              weekday: 'Tue',
              description: 'Cloudy',
              lowC: 14,
              highC: 20,
              precipProbabilityMax: 10,
            },
          ],
        };
      },
    );
  if (fixture.mailbox) {
    add(
      'calendar.search_events',
      'Search every connected calendar.',
      z.object({}).passthrough(),
      () => ({ complete: true, calendarsSearched: ['Fixture calendar'], events: [] }),
      { confidentialRead: true, returnsUntrustedContent: true },
    );
    add(
      'gmail.search',
      'Search the connected mailbox for messages matching the query. Read matching threads for details.',
      z.object({ query: z.string() }),
      () => ({
        complete: true,
        mailboxSearched: 'fixture@example.org',
        results:
          fixture.mailbox === 'hotel'
            ? [
                {
                  threadId: 'hotel-1',
                  subject: 'Harbor Hotel booking QA-BOOKING-123',
                  from: 'hotel@example.org',
                },
              ]
            : [],
      }),
      { confidentialRead: true, returnsUntrustedContent: true },
    );
    add(
      'gmail.read_thread',
      'Read all messages in a returned mailbox thread.',
      z.object({ threadId: z.literal('hotel-1') }),
      () => {
        if (fixture.mailbox !== 'hotel')
          throw new Error('No captured thread exists for this mailbox snapshot');
        return {
          messages: [
            {
              subject: 'Harbor Hotel booking QA-BOOKING-123',
              from: 'hotel@example.org',
              text: 'Harbor Hotel, Sunnyvale. Check-in September 5, 2026 at 4:00 PM. Check-out September 6 at 11:00 AM. Total $105.85.',
            },
          ],
        };
      },
      { confidentialRead: true, returnsUntrustedContent: true },
    );
  }
  if (fixture.memory) {
    add(
      'memory.save',
      'Save supplied facts to durable long-term memory. Include literal names, dates, quantities and notes. Does not schedule reminders or create graph links.',
      z.object({
        content: z.string().min(3).max(2000),
        subject: z.string().default(''),
        category: z.enum(['knowledge', 'experience']),
        kind: z.enum(['fact', 'preference', 'person', 'project', 'episode']),
        domain: z.string().optional(),
        importance: z.number().optional(),
        confidence: z.number().optional(),
      }),
      (args) => {
        const entry = { subject: String(args.subject), content: String(args.content) };
        const key = `${entry.subject}\n${entry.content}`;
        saved.set(key, entry);
        return { saved: true, id: randomUUID(), quarantined: false };
      },
      { writesMemory: true },
    );
    add(
      'memory.recall',
      'Read saved long-term memories matching a query.',
      z.object({ query: z.string(), limit: z.number().optional() }),
      () => ({ memories: [...saved.values()] }),
      { confidentialRead: true },
    );
  }
  return registry;
}

class ScriptedRouter {
  private index = 0;
  constructor(private fixture: QuestionCase) {}
  async step() {
    const entry = this.fixture.script[this.index++] ?? this.fixture.script.at(-1) ?? { text: '' };
    return {
      ok: true,
      modelId: 'regression/scripted',
      degraded: false,
      text: entry.text ?? '',
      finishReason: 'stop',
      toolCalls: (entry.toolCalls ?? []).map((call, i) => ({
        ...call,
        toolCallId: `replay-${this.index}-${i}`,
      })),
    };
  }
  async object(role: string, options?: { system?: string }) {
    if (role !== 'rewrite') throw new Error(`Unexpected scripted model role: ${role}`);
    return {
      ok: true,
      modelId: 'regression/scripted',
      degraded: false,
      finishReason: 'stop',
      object: options?.system?.startsWith('You compose a native information card')
        ? {
            cardable: !!this.fixture.expect.card,
            card: this.fixture.expect.card
              ? {
                  version: 1,
                  title: 'Harbor Hotel',
                  accessibilityLabel: 'Hotel reservation',
                  sourceLabel: 'gmail.read_thread',
                  facts: [{ id: 'hotel', value: 'Harbor Hotel', source: 'gmail.read_thread' }],
                  blocks: [{ type: 'hero', titleFact: 'hotel' }],
                }
              : undefined,
          }
        : { decision: 'publish', reasons: [] },
    };
  }
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0));
  }
}

class RollbackResult extends Error {
  constructor(readonly result: QuestionResult) {
    super('Replay completed; discard fixture state');
  }
}

/** Runs the real executor, dispatcher, response contract and verifier in a rolled-back transaction. */
export async function runQuestion(
  db: Db,
  fixture: QuestionCase,
  options: { router?: (db: Db) => ModelRouter; taskLimitUsd?: number } = {},
): Promise<QuestionResult> {
  const host = db.$client.options.host;
  const database = db.$client.options.database;
  if (
    !host.every((value) => ['localhost', '127.0.0.1', '::1'].includes(value)) ||
    !database.endsWith('_test')
  )
    throw new Error('Refusing replay outside a loopback _test database');
  try {
    await db.transaction(async (transaction) => {
      const replayDb = transaction as unknown as Db;
      const agent = await getAgent(replayDb);
      const [conversation] = await replayDb
        .insert(conversations)
        .values({
          agentId: agent.id,
          channel: 'chat',
          trust: 'owner',
          title: `Question regression: ${fixture.id}`,
        })
        .returning();
      if (!conversation) throw new Error('Cannot create fixture conversation');
      const at = new Date(
        fixture.mailbox === 'hotel' ? '2026-09-03T18:00:00Z' : '2026-09-08T05:00:00Z',
      );
      await replayDb.insert(messages).values(
        [...(fixture.history ?? []), { role: 'user', text: fixture.request }].map((message, i) => ({
          conversationId: conversation.id,
          role: message.role,
          origin: message.role === 'user' ? 'owner' : 'assistant',
          text: message.text,
          parts: [{ type: 'text', text: message.text }],
          createdAt: new Date(at.getTime() - 30_000 + i * 1000),
        })),
      );
      const { task } = await enqueueTask(replayDb, {
        event: {
          source: 'chat',
          trust: 'owner',
          agentId: agent.id,
          conversationId: conversation.id,
          payload: { text: fixture.request },
        },
        type: 'chat_turn',
        maxSteps: 12,
        plan: {
          action: fixture.plan ?? 'workflow',
          reasoning:
            'Answer the owner request using available evidence and perform requested work.',
          steps: [
            'Resolve the request using available tools and evidence',
            'Return the verified result and disclose incomplete work',
          ],
          missingInfo: [],
        },
      });
      await replayDb
        .update(tasks)
        .set({ createdAt: at, budgetUsdLimit: String(options.taskLimitUsd ?? 1) })
        .where(eq(tasks.id, task.id));
      const saved = new Map<string, { subject: string; content: string }>();
      const started = performance.now();
      const dispatcher = new ToolDispatcher(replayDb, replayRegistry(fixture, saved));
      const router =
        options.router?.(replayDb) ?? (new ScriptedRouter(fixture) as unknown as ModelRouter);
      let executionError: string | undefined;
      try {
        await executeTask({ db: replayDb, dispatcher, router }, task.id);
      } catch (error) {
        executionError = error instanceof Error ? error.name : 'ExecutionError';
      }
      const [finished] = await replayDb.select().from(tasks).where(eq(tasks.id, task.id));
      const delivered = await replayDb
        .select()
        .from(messages)
        .where(eq(messages.taskId, task.id))
        .orderBy(messages.createdAt);
      const calls = await replayDb
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.taskId, task.id))
        .orderBy(toolCalls.createdAt);
      const decisions = await replayDb
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, task.id));
      const modelRows = await replayDb
        .select({
          role: modelCalls.role,
          model: modelCalls.model,
          latencyMs: modelCalls.latencyMs,
          costUsd: modelCalls.costUsd,
        })
        .from(modelCalls)
        .where(eq(modelCalls.taskId, task.id));
      const costs = await replayDb
        .select({ usd: costEvents.usd })
        .from(costEvents)
        .where(eq(costEvents.taskId, task.id));
      const checks = await replayDb
        .select()
        .from(responseChecks)
        .where(eq(responseChecks.taskId, task.id));
      const pending = (
        finished?.state as { pendingFinal?: { text?: string; responseCards?: unknown[] } } | null
      )?.pendingFinal;
      const reply = delivered.filter((message) => message.role === 'assistant').at(-1);
      const result: Omit<QuestionResult, 'failures'> = {
        id: fixture.id,
        records: fixture.records,
        mode: options.router ? 'live' : 'scripted',
        status: finished?.status ?? 'missing',
        answer: reply?.text ?? pending?.text ?? finished?.progress ?? '',
        parts: (reply?.parts as unknown[]) ?? [],
        toolCalls: calls.map((call) => ({
          name: call.toolName,
          status: call.status,
          args: call.args,
          result: call.result,
        })),
        approvals: decisions.length,
        saved: [...saved.values()],
        elapsedMs: performance.now() - started,
        costUsd: costs.reduce((sum, call) => sum + Number(call.usd), 0),
        modelCalls: modelRows,
        verification: checks,
      };
      throw new RollbackResult({
        ...result,
        failures: [
          ...evaluateQuestion(fixture, result),
          ...(executionError ? [`execution: ${executionError}`] : []),
        ],
      });
    });
  } catch (error) {
    if (error instanceof RollbackResult) return error.result;
    throw error;
  }
  throw new Error('Replay transaction unexpectedly committed');
}

export function summarizeQuestions(results: QuestionResult[]) {
  const percentile = (values: number[], p: number) =>
    values.length ? ([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0) : 0;
  return {
    cases: results.length,
    passed: results.filter((result) => !result.failures.length).length,
    failed: results.filter((result) => result.failures.length).length,
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    approvals: results.reduce((sum, result) => sum + result.approvals, 0),
    p50Ms: percentile(
      results.map((result) => result.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      results.map((result) => result.elapsedMs),
      0.95,
    ),
    models: [...new Set(results.flatMap((result) => result.modelCalls.map((call) => call.model)))],
  };
}
