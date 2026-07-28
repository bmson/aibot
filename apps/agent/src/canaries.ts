import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type BrowserPlan,
  claimTask,
  completeTask,
  enqueueTask,
  executeTask,
  finishTask,
  getAgent,
  getRate,
  type ModelRouter,
  persistMessage,
  reconcileReservation,
  releaseReservation,
  reserveCost,
  resolveApproval,
  type StepCallOutcome,
} from '@assistant/core';
import { approvals, canaryRuns, conversations, type Db, messages, tasks } from '@assistant/db';
import { sendCanarySms } from '@assistant/modules';
import {
  AmbiguousBrowserJobLaunchError,
  buildRawEmail,
  isAmbiguousGoogleMutationError,
} from '@assistant/tools';
import type { ModelMessage } from 'ai';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { type AgentDeps, smsDeps } from './deps.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CHAT_BUDGET_USD = 0.01;
const BROWSER_BILLABLE_SECONDS = 90;
const STALE_RUN_MINUTES = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECK_TIMEOUTS_MS = {
  gmail: 60_000,
  sms: 60_000,
  browser: 180_000,
  approval: 20_000,
  chat: 60_000,
} as const;

export const CANARY_CHECK_NAMES = ['gmail', 'sms', 'browser', 'approval', 'chat'] as const;
export type CanaryCheckName = (typeof CANARY_CHECK_NAMES)[number];

export interface CanaryCheckResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
  skipped?: boolean;
}

export type CanaryChecks = Record<CanaryCheckName, CanaryCheckResult>;

export interface CanaryRunResult {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  ok: boolean | null;
  checks: Partial<CanaryChecks>;
  error?: string;
}

export type CanaryRunOutcome =
  | CanaryRunResult
  | { skipped: true; reason: 'already_running'; latest: CanaryRunResult | null };

interface CanaryOperationResult {
  detail: string;
  skipped?: boolean;
}

type CanaryOperations = Record<
  CanaryCheckName,
  (signal: AbortSignal) => Promise<string | CanaryOperationResult>
>;

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, ' ').slice(0, 300) || 'unknown error';
}

/** A check deadline aborts provider calls as well as bounding the route response. */
export async function runBoundedCanaryCheck(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<string | CanaryOperationResult>,
): Promise<CanaryCheckResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutError = new Error(`timed out after ${timeoutMs}ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });
  const checked = operation(controller.signal).then(
    (detail) => ({ kind: 'success' as const, detail }),
    (error: unknown) => ({ kind: 'failure' as const, error }),
  );
  try {
    const result = await Promise.race([checked, timeout]);
    if (result.kind === 'timeout') {
      // Provider calls are abort-aware; allow their cleanup/final metering to
      // finish before the run is finalized and the distributed lock is released.
      await Promise.race([checked, delay(20_000)]);
      return { ok: false, latencyMs: Date.now() - started, detail: timeoutError.message };
    }
    if (result.kind === 'failure') {
      return { ok: false, latencyMs: Date.now() - started, detail: safeError(result.error) };
    }
    const outcome = typeof result.detail === 'string' ? { detail: result.detail } : result.detail;
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail: outcome.detail.slice(0, 500),
      ...(outcome.skipped ? { skipped: true } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runCanaryOperationSet(operations: CanaryOperations): Promise<CanaryChecks> {
  const entries = await Promise.all(
    CANARY_CHECK_NAMES.map(async (name) => {
      const result = await runBoundedCanaryCheck(CHECK_TIMEOUTS_MS[name], operations[name]);
      return [name, result] as const;
    }),
  );
  return Object.fromEntries(entries) as CanaryChecks;
}

function rowToResult(row: typeof canaryRuns.$inferSelect): CanaryRunResult {
  return {
    runId: row.id,
    status: row.status as CanaryRunResult['status'],
    startedAt: row.startedAt.toISOString(),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ok: row.ok,
    checks: (row.checks ?? {}) as Partial<CanaryChecks>,
    ...(row.error ? { error: row.error } : {}),
  };
}

export async function latestCanaryRun(db: Db): Promise<CanaryRunResult | null> {
  const [row] = await db.select().from(canaryRuns).orderBy(desc(canaryRuns.startedAt)).limit(1);
  return row ? rowToResult(row) : null;
}

async function assertRunCostCeiling(deps: AgentDeps): Promise<void> {
  const [smsRate, browserRate] = await Promise.all([
    getRate(deps.db, 'twilio_sms'),
    getRate(deps.db, 'cloud_run_job_sec'),
  ]);
  const structuralMaximum =
    smsRate.unitPriceUsd + browserRate.unitPriceUsd * BROWSER_BILLABLE_SECONDS + CHAT_BUDGET_USD;
  if (structuralMaximum > deps.config.CANARY_MAX_COST_USD) {
    throw new Error(
      `structural canary maximum $${structuralMaximum.toFixed(4)} exceeds configured ceiling $${deps.config.CANARY_MAX_COST_USD.toFixed(4)}`,
    );
  }
}

function assertCanaryConfiguration(deps: AgentDeps): void {
  const missing: string[] = [];
  if (!deps.googleClient.configured()) missing.push('Google OAuth');
  if (!deps.browserLauncher) missing.push('browser module');
  if (!deps.config.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  if (deps.config.BROWSER_DRIVER === 'cloudrun') {
    if (!deps.config.GCP_PROJECT) missing.push('GCP_PROJECT');
    try {
      if (new URL(deps.config.PUBLIC_URL).protocol !== 'https:') missing.push('HTTPS PUBLIC_URL');
    } catch {
      missing.push('PUBLIC_URL');
    }
  }
  if (missing.length > 0) {
    throw new Error(`canary prerequisites are not configured: ${missing.join(', ')}`);
  }
}

async function cleanupGmailMarker(
  deps: AgentDeps,
  marker: string,
  knownIds: string[],
): Promise<void> {
  const signal = AbortSignal.timeout(15_000);
  const ids = new Set(knownIds);
  const query = `in:anywhere subject:"${marker}"`;
  const list = await deps.googleClient.api<{ messages?: Array<{ id: string }> }>(
    `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=10`,
    { signal },
  );
  for (const message of list.messages ?? []) ids.add(message.id);
  for (const id of ids) {
    // gmail.modify deliberately cannot permanently delete mail. Moving the
    // marker to Trash still removes it from the mailbox under test and lets
    // Gmail's retention policy clean it up without requiring the broader
    // full-mailbox scope.
    await deps.googleClient.api(`${GMAIL}/messages/${encodeURIComponent(id)}/trash`, {
      method: 'POST',
      signal,
    });
  }
}

async function gmailCanary(deps: AgentDeps, runId: string, signal: AbortSignal): Promise<string> {
  if (!deps.googleClient.configured()) throw new Error('Google OAuth is not configured');
  const agent = await getAgent(deps.db);
  const profile = await deps.googleClient.api<{ emailAddress: string }>(`${GMAIL}/profile`, {
    signal,
  });
  if (profile.emailAddress.toLowerCase() !== agent.email.toLowerCase()) {
    throw new Error('Google OAuth account does not match the configured agent mailbox');
  }

  const marker = `[assistant-canary:${runId}]`;
  const knownIds: string[] = [];
  try {
    try {
      const sent = await deps.googleClient.api<{ id: string }>(`${GMAIL}/messages/send`, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          raw: buildRawEmail({
            from: profile.emailAddress,
            to: [profile.emailAddress],
            subject: marker,
            body: `Automated Gmail delivery canary ${runId}. This message will be deleted.`,
          }),
        }),
      });
      knownIds.push(sent.id);
    } catch (error) {
      if (!isAmbiguousGoogleMutationError(error)) throw error;
      // Search by the unique marker instead of risking a duplicate send.
    }

    const query = `in:inbox subject:"${marker}"`;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const list = await deps.googleClient.api<{ messages?: Array<{ id: string }> }>(
        `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=5`,
        { signal },
      );
      if ((list.messages ?? []).length > 0) {
        for (const message of list.messages ?? []) knownIds.push(message.id);
        return 'self-addressed message reached the Gmail inbox and cleanup succeeded';
      }
      await delay(1_500, undefined, { signal });
    }
    throw new Error('self-addressed Gmail message did not reach the inbox within 45s');
  } finally {
    await cleanupGmailMarker(deps, marker, knownIds);
  }
}

async function smsCanary(deps: AgentDeps, runId: string, signal: AbortSignal): Promise<string> {
  const sent = await sendCanarySms(smsDeps(deps), runId);
  if (sent.deliveryStatus !== 'accepted' || !sent.sid) {
    throw new Error('Twilio accepted status is ambiguous; automatic retry suppressed');
  }

  const terminalSuccess = new Set(['sent', 'delivered']);
  const terminalFailure = new Set(['failed', 'undelivered', 'canceled']);
  while (!signal.aborted) {
    const status = await deps.twilio.getMessageStatus(sent.sid, signal);
    if (terminalSuccess.has(status.status)) {
      return `Twilio reported terminal delivery status ${status.status}`;
    }
    if (terminalFailure.has(status.status)) {
      throw new Error(
        `Twilio reported ${status.status}${status.errorCode ? ` (${status.errorCode})` : ''}`,
      );
    }
    await delay(2_000, undefined, { signal });
  }
  throw signal.reason ?? new Error('SMS status polling aborted');
}

const APPROVAL_PLAN: BrowserPlan = {
  goal: 'approval canary that must never launch',
  rung: 'headless',
  rationale: 'synthetic approval lifecycle check',
  steps: [
    { action: 'goto', url: 'https://example.com' },
    { action: 'click', selector: 'a', note: 'forces the approval tier' },
  ],
  useProfile: false,
  maxDurationSeconds: 30,
};

function approvalCanaryRouter(): ModelRouter {
  return {
    async object() {
      return {
        ok: true,
        modelId: 'canary/deterministic',
        degraded: false,
        object: {
          action: 'workflow',
          reasoning: 'exercise approval lifecycle',
          steps: ['propose and deny a synthetic browser action'],
          missingInfo: [],
        },
      };
    },
    async step(_role: string, opts: { messages?: ModelMessage[] }): Promise<StepCallOutcome> {
      const transcript = JSON.stringify(opts.messages ?? []);
      if (!transcript.includes('"toolName":"browser.execute"')) {
        return {
          ok: true,
          modelId: 'canary/deterministic',
          degraded: false,
          text: '',
          toolCalls: [
            {
              toolCallId: 'canary_approval_call',
              toolName: 'browser.execute',
              input: { plan: APPROVAL_PLAN },
            },
          ],
        };
      }
      return {
        ok: true,
        modelId: 'canary/deterministic',
        degraded: false,
        text: 'Synthetic approval denial observed.',
        toolCalls: [],
      };
    },
  } as unknown as ModelRouter;
}

async function approvalCanary(deps: AgentDeps, runId: string): Promise<string> {
  const agent = await getAgent(deps.db);
  const { task } = await enqueueTask(deps.db, {
    type: 'adhoc',
    budgetUsdLimit: '0.0010',
    maxSteps: 2,
    deferNotification: true,
    event: {
      source: 'internal',
      externalEventId: `canary:approval:${runId}`,
      agentId: agent.id,
      trust: 'owner',
      payload: { canary: true, runId },
    },
  });
  let approvalId: string | undefined;
  try {
    const parked = await executeTask(
      { db: deps.db, router: approvalCanaryRouter(), dispatcher: deps.dispatcher },
      task.id,
    );
    if (parked.outcome !== 'parked') {
      throw new Error(`approval workflow did not park (outcome ${parked.outcome})`);
    }
    const [approval] = await deps.db.select().from(approvals).where(eq(approvals.taskId, task.id));
    if (approval?.status !== 'pending') throw new Error('pending approval was not stored');
    approvalId = approval.id;
    const resolved = await resolveApproval(deps.db, {
      approvalId,
      decision: 'denied',
      via: 'web',
      deferNotification: true,
    });
    if (!resolved.ok) throw new Error(`approval resolution failed: ${resolved.reason}`);
    const resumed = await executeTask(
      { db: deps.db, router: approvalCanaryRouter(), dispatcher: deps.dispatcher },
      task.id,
    );
    const [[storedApproval], [storedTask]] = await Promise.all([
      deps.db.select().from(approvals).where(eq(approvals.id, approvalId)),
      deps.db.select().from(tasks).where(eq(tasks.id, task.id)),
    ]);
    if (
      resumed.outcome !== 'done' ||
      storedApproval?.status !== 'denied' ||
      storedTask?.status !== 'done'
    ) {
      throw new Error('denied approval did not wake and complete its workflow');
    }
    return 'approval parked, denied idempotently, woke, and completed without launching';
  } finally {
    if (approvalId) {
      await resolveApproval(deps.db, {
        approvalId,
        decision: 'denied',
        via: 'web',
        deferNotification: true,
      }).catch(() => undefined);
    }
    await completeTask(deps.db, task.id, {
      status: 'cancelled',
      progress: `canary cleanup ${runId}`,
    }).catch(() => undefined);
  }
}

async function chatCanary(deps: AgentDeps, runId: string, signal: AbortSignal): Promise<string> {
  if (!deps.config.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const agent = await getAgent(deps.db);
  const [conversation] = await deps.db
    .insert(conversations)
    .values({
      agentId: agent.id,
      channel: 'chat',
      trust: 'owner',
      title: `[Canary] chat ${runId.slice(0, 8)}`,
      metadata: { canary: true, runId },
    })
    .returning();
  if (!conversation) throw new Error('failed to create canary conversation');

  await persistMessage(deps.db, {
    conversationId: conversation.id,
    role: 'user',
    origin: 'system',
    parts: [{ type: 'text', text: 'Reply with exactly CANARY_OK.' }],
    text: 'Reply with exactly CANARY_OK.',
  });
  const { task } = await enqueueTask(deps.db, {
    type: 'chat_turn',
    budgetUsdLimit: CHAT_BUDGET_USD.toFixed(4),
    maxSteps: 1,
    deferNotification: true,
    event: {
      source: 'internal',
      externalEventId: `canary:chat:${runId}`,
      agentId: agent.id,
      conversationId: conversation.id,
      trust: 'owner',
      payload: { canary: true, runId },
    },
  });
  const lease = await claimTask(deps.db, task.id);
  if (!lease) throw new Error('failed to claim canary chat task');

  try {
    const outcome = await deps.router.stream('draft', {
      taskId: task.id,
      maxOutputTokens: 32,
      temperature: 0,
      abortSignal: signal,
      system: 'This is a health check. Follow the user instruction exactly and emit no extra text.',
      messages: [{ role: 'user', content: 'Reply with exactly CANARY_OK.' }],
      onComplete: async (text) => {
        await finishTask(deps.db, lease, {
          status: 'done',
          progress: `chat canary ${runId}`,
          responseText: text,
        });
      },
      onError: async (error) => {
        await finishTask(deps.db, lease, {
          status: 'failed',
          progress: safeError(error),
        });
      },
    });
    if (!outcome.ok) {
      await finishTask(deps.db, lease, {
        status: 'failed',
        progress: outcome.decision.reason,
      });
      throw new Error(`model routing blocked: ${outcome.decision.reason}`);
    }
    const text = (await outcome.text).trim();
    if (text !== 'CANARY_OK') {
      throw new Error('chat model did not return the exact canary response');
    }
    // AI SDK exposes the completed text just before its async onFinish
    // persistence callback becomes visible to a separate transaction. Poll
    // the durable state briefly so the canary checks the callback's result
    // instead of racing it.
    const persistenceDeadline = Date.now() + 5_000;
    while (true) {
      const [[storedTask], storedReplies] = await Promise.all([
        deps.db.select().from(tasks).where(eq(tasks.id, task.id)),
        deps.db
          .select()
          .from(messages)
          .where(and(eq(messages.taskId, task.id), eq(messages.role, 'assistant'))),
      ]);
      if (
        storedTask?.status === 'done' &&
        storedReplies.length === 1 &&
        storedReplies[0]?.text === text
      ) {
        return `model ${outcome.modelId} streamed the exact response and persistence completed`;
      }
      if (Date.now() >= persistenceDeadline) break;
      await delay(100, undefined, { signal });
    }
    throw new Error('chat response was not durably persisted with a terminal task');
  } finally {
    await deps.db
      .update(conversations)
      .set({ archivedAt: new Date(), updatedAt: sql`now()` })
      .where(eq(conversations.id, conversation.id))
      .catch(() => undefined);
    await completeTask(deps.db, task.id, {
      status: 'cancelled',
      progress: `canary cleanup ${runId}`,
    }).catch(() => undefined);
  }
}

async function browserCanary(deps: AgentDeps, runId: string, signal: AbortSignal): Promise<string> {
  const launcher = deps.browserLauncher;
  if (!launcher) throw new Error('browser module is disabled');
  if (
    deps.config.BROWSER_DRIVER === 'cloudrun' &&
    (!deps.config.GCP_PROJECT || !deps.config.PUBLIC_URL)
  ) {
    throw new Error('Cloud Run browser canary configuration is incomplete');
  }
  const rate = await getRate(deps.db, 'cloud_run_job_sec');
  const estimatedUsd = rate.unitPriceUsd * BROWSER_BILLABLE_SECONDS;
  const reservation = await reserveCost(deps.db, {
    source: 'cloud_run_job_sec',
    estimatedUsd,
    description: `canary browser ${runId}`,
  });
  if (!reservation.ok) throw new Error(reservation.reason);

  const rawToken = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await deps.db
    .update(canaryRuns)
    .set({ browserCallbackTokenHash: tokenHash })
    .where(and(eq(canaryRuns.id, runId), eq(canaryRuns.status, 'running')));

  const plan: BrowserPlan = {
    goal: 'read the fixed public canary page',
    rung: 'headless',
    rationale: 'exercise the sandboxed browser worker and signed callback',
    steps: [
      { action: 'goto', url: 'https://example.com', note: 'fixed public target' },
      { action: 'extract', selector: 'h1', what: 'page heading' },
    ],
    useProfile: false,
    maxDurationSeconds: 30,
  };

  let launchAttempted = false;
  let reservationSettled = false;
  const started = Date.now();
  try {
    launchAttempted = true;
    try {
      await launcher.launch({
        taskId: runId,
        plan,
        callbackUrl: `${deps.config.PUBLIC_URL}/webhooks/canaries/browser`,
        callbackToken: rawToken,
      });
    } catch (error) {
      if (!(error instanceof AmbiguousBrowserJobLaunchError)) {
        await releaseReservation(deps.db, reservation.reservationId);
        reservationSettled = true;
        throw error;
      }
      // The job may exist. Wait for its one-shot callback and meter conservatively.
    }

    let result: Record<string, unknown> | undefined;
    while (!signal.aborted) {
      const [row] = await deps.db
        .select({ result: canaryRuns.browserResult })
        .from(canaryRuns)
        .where(eq(canaryRuns.id, runId));
      if (row?.result && typeof row.result === 'object') {
        result = row.result as Record<string, unknown>;
        break;
      }
      await delay(1_000, undefined, { signal });
    }
    if (!result) throw signal.reason ?? new Error('browser callback did not arrive');

    const reportedDuration = Number(result.durationMs);
    const actualSeconds = Number.isFinite(reportedDuration)
      ? Math.max(1, Math.min(BROWSER_BILLABLE_SECONDS, Math.ceil(reportedDuration / 1000)))
      : Math.max(1, Math.min(BROWSER_BILLABLE_SECONDS, Math.ceil((Date.now() - started) / 1000)));
    await reconcileReservation(deps.db, reservation.reservationId, {
      usd: actualSeconds * rate.unitPriceUsd,
      quantity: actualSeconds,
      unit: rate.unit,
      unitPriceUsd: rate.unitPriceUsd,
      description: `canary browser ${runId}`,
    });
    reservationSettled = true;

    const outputs = Array.isArray(result.outputs) ? result.outputs : [];
    const extracted = outputs.some(
      (output) =>
        typeof output === 'object' &&
        output !== null &&
        (output as { action?: unknown }).action === 'extract' &&
        String((output as { text?: unknown }).text ?? '').includes('Example Domain'),
    );
    if (result.ok !== true || !extracted) {
      throw new Error(`browser worker returned an invalid result: ${safeError(result.error)}`);
    }
    return 'sandboxed worker loaded the fixed public page and its signed callback was verified';
  } finally {
    if (!reservationSettled) {
      if (launchAttempted) {
        await reconcileReservation(deps.db, reservation.reservationId, {
          usd: estimatedUsd,
          quantity: BROWSER_BILLABLE_SECONDS,
          unit: rate.unit,
          unitPriceUsd: rate.unitPriceUsd,
          description: `canary browser ${runId} (callback unavailable)`,
        }).catch((error) => console.error('browser canary metering failed', error));
      } else {
        await releaseReservation(deps.db, reservation.reservationId).catch(() => undefined);
      }
    }
  }
}

function canaryOperations(deps: AgentDeps, runId: string): CanaryOperations {
  const smsConfigured = deps.twilio.configured() && /^\+\d{7,15}$/.test(deps.config.OWNER_PHONE);
  return {
    gmail: (signal) => gmailCanary(deps, runId, signal),
    sms: smsConfigured
      ? (signal) => smsCanary(deps, runId, signal)
      : async () => ({
          detail: 'SMS integration is not configured; optional check skipped',
          skipped: true,
        }),
    browser: (signal) => browserCanary(deps, runId, signal),
    approval: () => approvalCanary(deps, runId),
    chat: (signal) => chatCanary(deps, runId, signal),
  };
}

/** Distributed single-flight entry point used by the internal route and Scheduler. */
export async function runCanaries(deps: AgentDeps): Promise<CanaryRunOutcome> {
  const connection = await deps.db.$client.reserve();
  let acquired = false;
  try {
    const [lock] = await connection<[{ acquired: boolean }]>`
      select pg_try_advisory_lock(hashtext('assistant:canaries')) as acquired
    `;
    acquired = lock?.acquired === true;
    if (!acquired) {
      return { skipped: true, reason: 'already_running', latest: await latestCanaryRun(deps.db) };
    }

    await deps.db
      .update(canaryRuns)
      .set({
        status: 'failed',
        ok: false,
        error: 'run abandoned before completion',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(canaryRuns.status, 'running'),
          sql`${canaryRuns.startedAt} < now() - (${STALE_RUN_MINUTES} * interval '1 minute')`,
        ),
      );

    const [run] = await deps.db.insert(canaryRuns).values({ status: 'running' }).returning();
    if (!run) throw new Error('failed to create canary run');
    try {
      assertCanaryConfiguration(deps);
      await assertRunCostCeiling(deps);
      const checks = await runCanaryOperationSet(canaryOperations(deps, run.id));
      const ok = CANARY_CHECK_NAMES.every((name) => checks[name].ok);
      const [completed] = await deps.db
        .update(canaryRuns)
        .set({ status: 'completed', ok, checks, finishedAt: new Date() })
        .where(and(eq(canaryRuns.id, run.id), eq(canaryRuns.status, 'running')))
        .returning();
      if (!completed) throw new Error('canary run lost its running state');
      return rowToResult(completed);
    } catch (error) {
      const [failed] = await deps.db
        .update(canaryRuns)
        .set({
          status: 'failed',
          ok: false,
          error: safeError(error),
          finishedAt: new Date(),
        })
        .where(eq(canaryRuns.id, run.id))
        .returning();
      return failed ? rowToResult(failed) : { ...rowToResult(run), status: 'failed', ok: false };
    }
  } finally {
    if (acquired) {
      await connection`select pg_advisory_unlock(hashtext('assistant:canaries'))`.catch((error) =>
        console.error('canaries: failed to release advisory lock', error),
      );
    }
    connection.release();
  }
}

function callbackTokenMatches(expectedHash: string, token: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{48}$/.test(token)) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = createHash('sha256').update(token).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type CanaryBrowserCallbackOutcome =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/** Authenticate and record the browser worker's bounded, one-shot canary result. */
export async function recordCanaryBrowserResult(
  db: Db,
  input: { runId: string; token: string; result: Record<string, unknown> },
): Promise<CanaryBrowserCallbackOutcome> {
  if (!UUID_RE.test(input.runId) || !input.token) {
    return { ok: false, status: 400, error: 'bad request' };
  }
  const [run] = await db.select().from(canaryRuns).where(eq(canaryRuns.id, input.runId));
  if (!run) return { ok: false, status: 404, error: 'canary run not found' };
  if (
    !run.browserCallbackTokenHash ||
    !callbackTokenMatches(run.browserCallbackTokenHash, input.token)
  ) {
    return { ok: false, status: 403, error: 'invalid token' };
  }
  if (run.browserResult) return { ok: true, duplicate: true };
  if (run.status !== 'running') {
    return { ok: false, status: 409, error: 'canary run no longer accepts callbacks' };
  }
  const [recorded] = await db
    .update(canaryRuns)
    .set({ browserResult: input.result })
    .where(
      and(
        eq(canaryRuns.id, input.runId),
        eq(canaryRuns.status, 'running'),
        isNull(canaryRuns.browserResult),
      ),
    )
    .returning({ id: canaryRuns.id });
  if (recorded) return { ok: true, duplicate: false };
  const [current] = await db
    .select({ result: canaryRuns.browserResult })
    .from(canaryRuns)
    .where(eq(canaryRuns.id, input.runId));
  return current?.result
    ? { ok: true, duplicate: true }
    : { ok: false, status: 409, error: 'canary callback lost its acceptance race' };
}
