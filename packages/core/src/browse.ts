import { z } from 'zod';
import type { ModelRouter } from './model-router/router.js';

/**
 * Browser plans — the two-stage browser.plan → approval → browser.execute
 * contract. The schema lives in core so the executor (core), the tools
 * package, and the planner all share one definition without a package cycle.
 * The browser-job worker keeps its own minimal structural copy (it must not
 * depend on core: no DB creds, no model SDKs in the job image).
 */

export const BrowserStepSchema = z.object({
  action: z.enum([
    // read-only
    'goto',
    'waitFor',
    'extract',
    'screenshot',
    'scroll',
    // interactive — any of these makes the plan approval-gated
    'click',
    'type',
    'select',
    'press',
  ]),
  /** goto */
  url: z.string().optional(),
  /** click / type / select / waitFor / extract — CSS selector or text=... */
  selector: z.string().optional(),
  /** type */
  text: z.string().optional(),
  /** select */
  value: z.string().optional(),
  /** press — e.g. Enter */
  key: z.string().optional(),
  /** screenshot label */
  name: z.string().optional(),
  /** extract — what to pull, in plain words (used when selector is omitted) */
  what: z.string().optional(),
  /** human-readable intent; shown on approval cards */
  note: z.string().optional(),
});
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

/** Escalation ladder: cheapest capable rung wins; 'visual' is a last resort. */
export const BrowserLadderSchema = z.enum(['api', 'fetch', 'parse', 'headless', 'visual']);

export const BrowserPlanSchema = z.object({
  goal: z.string().min(3).max(500),
  rung: BrowserLadderSchema,
  rationale: z.string().default(''),
  /** rung api/fetch/parse: the URL web.fetch should hit instead of a browser. */
  fetchSuggestion: z.string().optional(),
  /** rung headless/visual: the explicit steps — exactly what the owner approves. */
  steps: z.array(BrowserStepSchema).max(30).default([]),
  /** Load the persisted (encrypted) browser profile — cookies, sessions. */
  useProfile: z.boolean().default(true),
  maxDurationSeconds: z.number().int().min(30).max(600).default(180),
});
export type BrowserPlan = z.infer<typeof BrowserPlanSchema>;

export const INTERACTIVE_ACTIONS: ReadonlySet<BrowserStep['action']> = new Set([
  'click',
  'type',
  'select',
  'press',
]);

/** True when the plan only reads — the autonomous tier of browser.execute. */
export function isReadOnlyPlan(plan: Pick<BrowserPlan, 'steps'>): boolean {
  return plan.steps.every((s) => !INTERACTIVE_ACTIONS.has(s.action));
}

// ── Pending-job sentinel ──────────────────────────────────────────────────────
// browser.execute launches the job and returns this marker; the executor sees
// it, parks the task (sleeping, with a timeout backstop), and the job's
// callback wakes it with the real result stitched into the tool_calls row.

export const BROWSER_JOB_PENDING = 'browser_job_pending' as const;

export interface BrowserJobPendingResult {
  pending: typeof BROWSER_JOB_PENDING;
  callbackToken: string;
  /** ISO timestamp: when the sweeper should give up and wake the task anyway. */
  timeoutAt: string;
  executionName?: string;
}

export function isBrowserJobPending(result: unknown): result is BrowserJobPendingResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { pending?: unknown }).pending === BROWSER_JOB_PENDING &&
    typeof (result as { callbackToken?: unknown }).callbackToken === 'string'
  );
}

// ── Planner (escalation ladder) ───────────────────────────────────────────────

const LADDER_PROMPT = `You plan how an assistant should get information from (or act on) the web.
Escalation ladder — always pick the CHEAPEST rung that can do the job:
1. "api"   — the site has a public JSON/REST endpoint; return it as fetchSuggestion.
2. "fetch" — a plain HTTP GET of a page returns the answer in its HTML; return the URL as fetchSuggestion.
3. "parse" — like fetch but the answer needs digging out of the HTML; still just fetchSuggestion.
4. "headless" — the page needs JavaScript rendering or multi-step navigation; produce explicit steps.
5. "visual" — DOM extraction won't work (canvas, anti-bot layouts); steps ending in screenshots. Last resort.

For rungs 1–3: set fetchSuggestion and leave steps empty — the caller will use its web.fetch tool.
For rungs 4–5: write the complete, explicit step list. Selectors should be robust (prefer text= or aria labels
over brittle CSS chains). Every step gets a short "note" saying why. Never include credentials or payment data
in any step — logging in and purchasing are not things you can plan; if the goal requires them, say so in
rationale and plan only the read-only part. Interactive steps (click/type/select/press) require owner approval,
so prefer read-only step sequences (goto, waitFor, extract, screenshot) when they suffice.
Keep plans short: one goto, a waitFor, then extract what's needed.`;

export async function planBrowse(
  router: ModelRouter,
  input: { goal: string; context?: string; taskId?: string },
): Promise<BrowserPlan> {
  const outcome = await router.object<BrowserPlan>('plan', {
    taskId: input.taskId,
    system: LADDER_PROMPT,
    prompt: [
      `Goal: ${input.goal}`,
      input.context ? `Context:\n${input.context}` : '',
      'Produce the browse plan.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    schema: BrowserPlanSchema,
  });
  if (!outcome.ok) {
    throw new Error(`browse planning blocked by budget: ${outcome.decision.reason}`);
  }
  return BrowserPlanSchema.parse(outcome.object);
}
