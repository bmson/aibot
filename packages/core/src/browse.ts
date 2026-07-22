import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelRouter } from './model-router/router.js';

/**
 * Hash a browser-job callback token for at-rest storage and comparison. The raw
 * token travels only to the job (via the launcher) and back on its one-shot
 * callback; only its SHA-256 is ever persisted in the task checkpoint, so DB
 * read access cannot recover a still-valid callback credential. Mirrors the
 * canary path, which already stores only the hash.
 */
export function hashCallbackToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The browser worker may read only this narrow, attachment-only Workspace area. */
export const BROWSER_ATTACHMENT_PREFIX = 'browser/attachments/';

/** Reject traversal, profile files, and arbitrary Workspace data as browser uploads. */
export function isBrowserAttachmentPath(workspacePath: string): boolean {
  if (!workspacePath.startsWith(BROWSER_ATTACHMENT_PREFIX) || workspacePath.includes('\\')) {
    return false;
  }
  const parts = workspacePath.split('/');
  return (
    parts.length >= 3 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

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
    'upload',
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
  /** upload — a previously staged path from drive.download in the assistant Workspace. */
  workspacePath: z.string().max(300).optional(),
  /** screenshot label */
  name: z.string().optional(),
  /** extract — what to pull, in plain words (used when selector is omitted) */
  what: z.string().optional(),
  /** human-readable intent; shown on approval cards */
  note: z.string().optional(),
});
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

/** Escalation ladder: cheapest capable rung wins; 'visual' is a last resort. */
export const BrowserLadderSchema = z.enum([
  'search',
  'api',
  'fetch',
  'parse',
  'headless',
  'visual',
]);

/** A browse plan never runs more than this many steps; enforced post-parse. */
export const MAX_BROWSER_STEPS = 30;

export const BrowserPlanSchema = z
  .object({
    goal: z.string().min(3).max(500),
    rung: BrowserLadderSchema,
    rationale: z.string().default(''),
    /** rung api/fetch/parse: the URL web.fetch should hit instead of a browser. */
    fetchSuggestion: z.string().optional(),
    /** rung search: the query to run through web.search when no URL is known yet. */
    searchQuery: z.string().optional(),
    /**
     * rung headless/visual: the explicit steps — exactly what the owner approves.
     * No `.max()` here: the 'reason' role's provider rejects a schema carrying
     * maxItems, so the cap (MAX_BROWSER_STEPS) is enforced after parsing instead.
     */
    steps: z.array(BrowserStepSchema).default([]),
    /** Load the persisted encrypted browser profile only when authenticated state is required. */
    useProfile: z.boolean().default(false),
    maxDurationSeconds: z.number().int().min(30).max(600).default(180),
  })
  .superRefine((plan, ctx) => {
    plan.steps.forEach((step, index) => {
      if (
        step.action === 'upload' &&
        (!step.workspacePath || !isBrowserAttachmentPath(step.workspacePath))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'workspacePath'],
          message: `uploads must use a staged ${BROWSER_ATTACHMENT_PREFIX} path`,
        });
      }
    });
  });
export type BrowserPlan = z.infer<typeof BrowserPlanSchema>;

export const INTERACTIVE_ACTIONS: ReadonlySet<BrowserStep['action']> = new Set([
  'click',
  'type',
  'select',
  'press',
  'upload',
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
0. "search" — you do not know a URL and no obvious authoritative site comes to mind; set searchQuery and leave
   steps/fetchSuggestion empty. The caller runs its web.search tool and re-plans with the real result URLs. Only
   use this rung when a web.search tool is available to you; if it is not, pick the most likely site directly.
1. "api"   — the site has a public JSON/REST endpoint; return it as fetchSuggestion.
2. "fetch" — a plain HTTP GET of a page returns the answer in its HTML; return the URL as fetchSuggestion.
3. "parse" — like fetch but the answer needs digging out of the HTML; still just fetchSuggestion.
4. "headless" — the page needs JavaScript rendering or multi-step navigation; produce explicit steps.
5. "visual" — DOM extraction won't work (canvas, anti-bot layouts); steps ending in screenshots. Last resort.

Not knowing the target URL is never a reason to refuse. When the goal names what to find but not where and an
authoritative site is obvious, go straight to it — a company's own careers page, an official tourism board or
city site, Wikipedia/Wikivoyage for places, a project's own docs. When no such site is obvious, use the "search"
rung to find one rather than guessing. Major search engines answer datacenter traffic with CAPTCHA walls, so never
plan a fetch of a Google/DuckDuckGo/Bing results page and never plan around solving a challenge; that is what the
web.search tool (rung 0) is for. Prefer a site's own listing/API page once you know which site it is.
Put the query in the URL rather than typing into a search box: an interactive step (click/type/select/press)
turns the whole plan into something the owner must approve by hand, so a plan that only navigates and extracts
is the difference between work that happens now and work that waits. Chain several goto/extract pairs in one
read-only plan instead of reaching for a click.
For rungs 1–3: set fetchSuggestion and leave steps empty — the caller will use its web.fetch tool.
For rungs 4–5: write the complete, explicit step list. Selectors should be robust (prefer text= or aria labels
over brittle CSS chains). Every step gets a short "note" saying why. Never include credentials or payment data
in any step — logging in and purchasing are not things you can plan; if the goal requires them, say so in
rationale and plan only the read-only part. Interactive steps (click/type/select/press) require owner approval,
so prefer read-only step sequences (goto, waitFor, extract, screenshot) when they suffice.
For a file upload, first obtain the exact Workspace path with drive.download, then use its browser/attachments/ path
in an upload step with a file-input selector. Uploads always require owner approval and must be followed by a clear
confirmation extract; never guess that a form was submitted.
Set useProfile=true only when the goal explicitly requires an existing authenticated session; otherwise keep it false.
For research and discovery, prefer sources that are readable signed-out, and avoid sites that gate content behind a
login or whose terms forbid automated access (LinkedIn in particular). There is almost always a public equivalent —
a company's own careers page, a public job board, an RSS feed, a documented JSON endpoint — and it is both more
reliable to parse and cheaper to reach. Needing useProfile for a research goal is a sign the wrong source was chosen.
Keep plans short: one goto, a waitFor, then extract what's needed.`;

// Authored with the 'reason' role (Claude): it produces markedly better
// read-only, query-in-URL plans than the cheap 'plan' role. The schema emits
// without maxItems (that role's provider rejects it), so the step cap is
// enforced post-parse below. LADDER_PROMPT carries the read-only guidance.
export async function planBrowse(
  router: ModelRouter,
  input: { goal: string; context?: string; taskId?: string },
): Promise<BrowserPlan> {
  const outcome = await router.object<BrowserPlan>('reason', {
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
  const plan = BrowserPlanSchema.parse(outcome.object);
  // Enforce the step cap the schema no longer carries.
  if (plan.steps.length > MAX_BROWSER_STEPS) {
    plan.steps = plan.steps.slice(0, MAX_BROWSER_STEPS);
    plan.rationale = `${plan.rationale} (truncated to ${MAX_BROWSER_STEPS} steps)`.trim();
  }
  return plan;
}
