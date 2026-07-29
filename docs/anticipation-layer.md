# Anticipation layer: watchers + a standing briefing

Design for the assistant acting *before* it is asked. Two capabilities, one shared discipline:

1. **Watchers** — durable, owner-defined triggers ("tell me if X emails", "watch this page for a
   change") that fire when a real-world event matches explicit criteria.
2. **The briefing** — a standing, scheduled digest (calendar conflicts, things that need the owner,
   mission/goal deltas, watcher hits, suggested next actions) delivered in the owner's voice.

Status: **Phase 1 shipped** — notify-tier email watchers (the `watches`/`watch_fires` tables, the
`watch.create`/`watch.list`/`watch.cancel` tools, the `matchEmailWatches` pass on the inbound-mail
hook, and the expiry reaper). Phases 2–4 remain proposed. This document is the source of truth for
the design. It deliberately reuses the two pieces of machinery that already exist for exactly this
shape of work — the application-confirmation *watch* and the goal-automation *schedule* — and copies
their security discipline verbatim rather than inventing a new one.

## Goal / non-goals

**Goal.** Turn the assistant from purely reactive (it acts when the owner writes to it, or when a
mission it already owns wakes) into *anticipatory*: it surfaces the thing the owner would have wanted
to know, and — only within pre-authorized, frozen bounds — acts on it, without being prompted each
time.

**Non-goals.**

- **Not a general "if-this-then-that" engine that lets the model synthesize outward actions from
  untrusted triggers.** An autonomous action from a watcher is only ever an *exact bundle the owner
  froze and approved when the watch was created* (the application-confirmation rule, generalized).
  Everything else a watcher can do is *surface to the owner* — a notice or a suggestion — never an
  outward side effect.
- **Not a new autonomy tier.** Watchers and the briefing run under the existing trust/taint gate,
  the existing approval spine, and the existing budget guard. If a capability would need a new
  exception to those, it is out of scope.
- **Not always-on polling of the whole inbox/web.** Watchers are bounded (expiry, max-fires,
  explicit match criteria) and the briefing runs on a cadence, not a hot loop.
- **Not a replacement for missions.** A mission is open-ended work the assistant *performs*. A
  watcher is a *condition* it waits on. They compose (a watcher can hand off to a mission) but they
  are different primitives.

## The bad version we are explicitly avoiding

The tempting version is a rules UI where the owner writes "when I get an email about my flight, book
a cab" and the model reads the email and does whatever it decides. That collapses the entire
security model: the trigger is **untrusted content**, and we would be letting untrusted content
choose and parameterize an outward action. The application-confirmation flow already solved this the
right way — the owner approves *every literal argument of the future action up front*, the untrusted
email only *selects which frozen bundle fires* (authenticated sender + opaque token), and execution
is **deterministic and never routes through the model**
(`packages/modules/src/google/application-confirmations.ts`). This design generalizes that solution;
it does not relax it.

## What already exists (this design mostly wires it together)

| Capability | Where | Reused as |
| --- | --- | --- |
| Owner-approved *watch* holding every frozen future side-effect arg | `applications.watch_confirmation` (`packages/tools/src/applications.ts:151`), `application_confirmations` table (`packages/db/src/schema.ts:383`) | The prototype for the general `watches` row + the `frozen_action` tier. |
| Deterministic match of untrusted inbound mail → frozen action | `processApplicationConfirmation` (`packages/modules/src/google/application-confirmations.ts:578`); authenticated sender + opaque-token match, ambiguity → change nothing + escalate | The email-watch matcher, generalized. |
| Deterministic, model-free execution of the frozen bundle | `executeApplicationConfirmationTask` (`application-confirmations.ts:376`): idempotency keys, ledger reconciliation, "unknown ⇒ suppress retry" | The `frozen_action` firing path. |
| Proactive expiry + owner notice for a watch that never fires | `reapExpiredApplicationWatches` (`application-confirmations.ts:525`) | Watch expiry, generalized. |
| Cron schedules, idempotent per firing, with **code-job** templates | `runDueSchedules` (`packages/core/src/workflow/schedules.ts:292`), `template.job` (`schedules.ts:360`) | The briefing runs as a scheduled code-job. |
| Priority/deadline-derived cadence | `goalAutomationCadence` (`schedules.ts:56`) | The model for a per-agent briefing cadence. |
| Code-job dispatch (runs a registered fn, not the model loop; meters cost; can yield/resume) | `CodeJobName` + `runCodeJob` (`packages/core/src/memory/jobs.ts:29`) | Add `briefing.compose` and `watch.poll_web` here. |
| Reduced registry for untrusted / no-outward-tool context | `packages/tools/src/registry.ts:26-31` (`outwardFacing` dropped), taint gate `executor.ts:1098,1138` | The registry a `suggest`-tier watcher and the briefing run under. |
| Off-dashboard owner delivery | `owner.notify` (`packages/tools/src/builtin/index.ts:551`), `notifyOwnerBySms` (`packages/modules/src/sms/channel.ts`), `notifyOwner` dep (`executor.ts:142`) | Briefing + watch-hit delivery. |
| Voice rewrite with fact-preservation check | `rewriteInVoice` (`packages/core/src/voice.ts:63`) | The briefing is composed in the owner's voice. |
| "Reference data, never instructions" framing for carried untrusted text | `sessionInstruction` (`missions.ts:94`), `goalInstruction` (`schedules.ts:131`) | How trigger content is presented to any model step. |

The materials are in place. The gaps are: (1) the watch primitive is hard-coded to job applications;
(2) nothing composes a standing digest; and (3) there is no owner-facing *suggestion* surface — only
approvals (tied to an already-queued tool call) and needs-attention.

## Architecture

### One primitive: the `watches` table

A `watches` row is a durable, owner-owned condition. It generalizes `application_confirmations`
without touching it — the hardened application path keeps working as-is; folding it onto `watches` is
a later, optional cleanup (see Open questions), not a v1 requirement.

```
watches
  id, agent_id, conversation_id
  kind          'email' | 'web'                    -- how the trigger is observed
  tier          'notify' | 'suggest' | 'frozen_action'
  name, description
  match         jsonb   -- email: {expectedSenderEmails[], tokenHint?, keywords?}
                        -- web:   {url, selector?, mode: 'hash'|'text'}
  frozen_action jsonb   -- ONLY for tier='frozen_action': a policy-template-shaped bundle
                        --   (reuses the constrained-template idea from approval policies)
  status        'active' | 'fired' | 'expired' | 'cancelled'
  expires_at, max_fires, fire_count, last_fired_at
  provenance    jsonb   -- planner/prompt versions, model, created_via (same shape as tool_calls.decision)
```

Watches are created through the normal tool + approval path (a `watch.create` tool, `risk: approval`
when `tier='frozen_action'`, `risk: autonomous` for `notify`/`suggest` since those take no outward
action). A `frozen_action` watch's approval dialog shows the *exact* future action, exactly as
`applications.watch_confirmation` does today (`approvalSummary`, `applications.ts:160`).

### The three tiers — the whole safety story is which tier can do what

| Tier | On match, it… | Model sees untrusted trigger? | Can take an outward action? |
| --- | --- | --- | --- |
| `notify` | posts a notice + `owner.notify` | no | no |
| `suggest` | drafts a *suggestion* (reduced registry, taint-on) and surfaces it | yes, as **reference data only** | no — the owner accepting the suggestion creates a normal, approval-gated task |
| `frozen_action` | runs the frozen bundle deterministically (no model) | **no** | yes, but only the exact pre-approved bundle |

This table is the design. The invariant it encodes: **untrusted content can select and it can
inform the owner, but it can never author an outward action.** `frozen_action` fires a bundle the
owner already read and approved; `suggest` produces text the owner must still act on; `notify` is
inert. A watcher never widens the registry the trigger's trust level would otherwise allow.

### Matching

**Email watches.** Extend the inbound-mail hook that already runs `processApplicationConfirmation`
(driven from `email-sync`) to also run a general `matchWatches` pass over `kind='email'` rows. Same
gate: only `input.authenticated` mail (receiver-authenticated, From-aligned SPF/DKIM/DMARC —
`ApplicationConfirmationInput.authenticated`) is eligible. Candidate = sender ∈
`expectedSenderEmails`; refine by `tokenHint` (opaque-token hash match, reuse
`confirmationTokenHashes`, `application-confirmations.ts:53`) and/or owner-supplied `keywords`.
Ambiguity (a `frozen_action` match against >1 watch) copies the existing rule exactly: **change
nothing, mark needs-attention, tell the owner** (`reportAmbiguous`, `application-confirmations.ts:93`).

**Web watches.** A new scheduled code-job `watch.poll_web` fetches each active `kind='web'` row's
URL through the **existing sandboxed `web.fetch`** (public-read, egress-restricted — the same worker
that already blocks WebRTC and arbitrary egress), extracts the configured selector/text, hashes it,
and fires on change from the stored hash. Polite polling: honor `ETag`/`Last-Modified`, exponential
backoff on failure, and a per-watch min interval. A transient fetch failure must **not** count as a
change.

> **Status: built (notify-tier v1).** The `notify`-tier web watch ships. The owner creates one with
> the `watch.web` tool (`packages/tools/src/watches.ts`) — `{ url, mode, pattern?, intervalMinutes }`
> — and `pollDueWebWatches` (`packages/modules/src/watches/web-watches.ts`) runs as a **sweep step**,
> claiming due rows atomically (bump `next_poll_at`, so a concurrent instance claims none), fetching
> through `fetchPublicWebPage`, and firing through the shared `recordWatchFire`. Detection
> (`webWatchOutcome`, `packages/tools/src/web-watches.ts`) is deterministic and never enters a model
> context; it records a baseline on the first poll and fires only on a transition. Modes shipped:
> `change` (content hash), `contains`, `absent` — `pattern`-based rather than the `hash`/`text` +
> `selector` sketch above. A bot-challenge wall or fetch error never counts as a change and, after
> five consecutive failures, expires the watch with one owner notice. Deltas from this design, still
> deferred: promotion to a durable, cost-metered **code-job** (v1 is a sweep step); CSS-`selector`
> scoping; `ETag`/`Last-Modified` conditional polling; and the `suggest`/`frozen_action` tiers.

### Firing

- **`frozen_action`** → enqueue an `internal` task carrying `{ kind: 'watch_fire', watchId }` and run
  it through a deterministic worker modeled on `executeApplicationConfirmationTask`
  (`application-confirmations.ts:376`): status-guarded transitions, per-action idempotency keys,
  ledger reconciliation, and the **"provider result unknown ⇒ suppress automatic retry"** rule
  (`applications.ts:396`). The model is never in this path.
- **`notify`** → post a notice into the watch's conversation + `notifyOwnerBySms`. No task, no action.
- **`suggest`** → one bounded model call, **reduced registry (read + `owner.notify` only), taint
  flag on**, trigger content injected as *reference data, never instructions* (the
  `sessionInstruction` framing, `missions.ts:94`). Output is a **suggestion**, not an action.

### The suggestion surface

`suggest`-tier watchers and the briefing both need to say "I noticed X — want me to Y?" and have
"Yes" *create* the work. Approvals don't fit (they attach to an already-queued tool call); needs
-attention is a dead-end status. Recommendation: a lightweight **`suggestions`** concept —
`{ id, agent_id, conversation_id, summary, proposed_action (a planner seed), status:
pending|accepted|dismissed|snoozed, expires_at }`. Accepting enqueues an ordinary owner-trust task
through the planner, so *every* resulting outward action still hits the normal approval spine. This
keeps the "watcher authored nothing outward" invariant intact: the suggestion is inert text until
the owner promotes it, and promotion runs the full pipeline. (Alternative considered: reuse the
approvals table with a `suggested` flag — rejected; it muddies the "an approval == a frozen queued
call" meaning that the executor and SMS `YES A7` flow rely on.)

### The briefing

A per-agent standing **schedule** whose `taskTemplate.job = 'briefing.compose'` — a new
`CodeJobName` (`memory/jobs.ts:29`). It reuses everything: idempotent firing
(`schedule:<id>:<next_run_at>`), cost metering to the task, retry/dead-letter machinery.

The job:

1. **Assembles structured inputs** — today+next-N-days calendar and conflicts, `needs_attention`
   tasks, pending approvals (count + summaries), mission/goal progress *deltas since the last
   briefing*, watcher hits, and open suggestions. These are owner-privileged, mostly non-tainted
   sources.
2. **Composes** with one bounded model call under a **read-only + `owner.notify` registry** and the
   voice profile (`rewriteInVoice`, `voice.ts:63`). Running with no outward tools reachable is the
   structural guarantee the briefing can't be steered into an action — the same mechanism untrusted
   tasks already rely on (`registry.ts:26`).
3. **Delivers** into the primary thread + `owner.notify`.

Two disciplines carried over from elsewhere in the codebase:

- **No fabricated urgency.** The briefing may claim only what the structured inputs support — the
  response-contract stance (`packages/core/src/workflow/response-contract.ts`) applied to a digest.
  Empty day ⇒ a one-line "nothing needs you," or skip entirely (owner setting). No inventing a
  reason to ping.
- **Taint isolation.** If the briefing summarizes email subjects/senders, that content is tainted;
  it may inform the owner-facing digest but must never reach the voice-sample store or any outward
  tool. Since the briefing's only output is *to the owner* and it holds no outward tools, this is
  satisfied by construction — but the test matrix pins it (no tainted content reaches
  `writing_samples`).

Cadence comes from an owner setting (default: weekday morning in `agent.timezone`, mirroring
`goalAutomationCadence`'s `15 9 * * *` daily shape). Default **off** until the owner opts in.

## Hard properties (the acceptance bar)

1. **No autonomous outward action outside a frozen, owner-approved bundle.** Only `frozen_action`
   watchers act, and only the exact bundle approved at creation. Enforced in code (deterministic
   worker + policy-template-shaped `frozen_action`), not prompt.
2. **Untrusted trigger content never becomes an instruction.** `frozen_action` execution never
   routes through the model; `suggest`/briefing model steps run with a reduced registry and inject
   trigger content as reference data only.
3. **No false positives.** A watcher fires only on an explicit, owner-set match (authenticated
   sender + opaque token/keywords; a real content-hash change). Ambiguous ⇒ change nothing +
   escalate.
4. **Idempotent + at-least-once safe.** Same discipline as schedules and confirmations:
   `externalEventId` dedupe, status-guarded transitions, ledger reconciliation, unknown-provider ⇒
   suppress retry.
5. **Bounded.** Every watch has an expiry and a max-fire count; the briefing and web polling respect
   the per-task/daily/monthly budget guard. A misconfigured or hostile watcher cannot exceed its
   fire cap or its budget.

## Phased rollout

- **Phase 1 — `notify`-tier email watchers. ✅ Shipped.** `watches` + `watch_fires` tables,
  `watch.create`/`watch.list`/`watch.cancel` tools, the `matchEmailWatches` pass wired into the
  existing inbound-mail hook (side-effect only — it never short-circuits normal triage), and an
  expiry reaper on the sweep. Zero autonomous action ⇒ lowest risk, immediate "it noticed" value.
  Firing is idempotent per (watch, message) via the `watch_fires` unique index.
- **Phase 2 — the briefing + suggestion surface.** `briefing.compose` code-job, per-agent cadence
  setting, `suggestions` table and dashboard surface, `suggest`-tier watchers.
- **Phase 3 — web-change watchers.** `watch.poll_web` code-job over sandboxed `web.fetch` with
  polite polling.
- **Phase 4 — `frozen_action` tier, generalized.** Lift the application-confirmation execution
  discipline into a general frozen-bundle worker; optionally reimplement `application_confirmations`
  on top of `watches` (behind tests, no behavior change).

## Regression contract (test matrix)

A watcher/briefing scenario is "supported" only when the ledger, task/watch state, provider result,
and owner-visible output all agree — the same bar as `docs/complex-workflow-test-matrix.md`.

| Scenario | Required outcome |
| --- | --- |
| Authenticated mail matches one `notify` watch | One notice + one owner ping; no task, no outward call; fire_count increments once |
| Match is replayed / late / from a forged (unauthenticated) sender | Accept once; ignore replays and unauthenticated mail; change nothing |
| Authenticated mail matches >1 `frozen_action` watch | Change nothing, mark needs-attention, tell the owner (parity with `reportAmbiguous`) |
| `frozen_action` fires | Exactly the approved bundle runs, once; idempotent under redelivery; provider-unknown suppresses retry |
| `suggest` watcher on untrusted mail | Produces a suggestion only; the model step has no outward tool in registry; accepting it runs the full approval pipeline |
| Web watch, content changes once | Fires once per distinct change; transient fetch failure never fires; egress sandbox intact |
| Watch window closes with no match | Reaped to `expired` with an owner notice (parity with `reapExpiredApplicationWatches`) |
| Briefing, ordinary day | Digest composed only from the structured inputs; no outward tool reachable; delivered to owner in voice |
| Briefing, empty day | One-line "nothing needs you" or skip per setting; no fabricated urgency |
| Briefing taint | No tainted email content reaches `writing_samples` or any outward tool |
| Cost | Briefing + web polling respect per-task/daily ceilings; a watcher cannot exceed max_fires or budget |

## Rejected alternatives

- **A model-driven rules engine** ("when X, do whatever you think"). Rejected: lets untrusted
  triggers author outward actions. The frozen-bundle + suggestion split is the whole point.
- **Autonomous model workflows on watch fire.** Rejected for the same taint reason; autonomous fire
  is `frozen_action`-only.
- **The briefing as a mission.** A mission is stateful open-ended *work*; the briefing is a
  stateless recurring *render*. A scheduled code-job is the right primitive and reuses more.
- **Suggestions reusing the approvals table.** Rejected: an approval means "a concrete tool call is
  queued and frozen"; a suggestion has no queued call yet. Overloading it weakens the SMS `YES A7`
  and executor invariants.

## Open questions

- **Suggestion surface:** dedicated `suggestions` table (recommended) vs. an approvals subtype.
- **Fold `application_confirmations` into `watches` now or later?** Recommend later (Phase 4), behind
  tests, no behavior change — do not disturb the hardened flagship path in v1.
- **Web-watch politeness + robots:** default min interval, `robots.txt` honoring, and whether web
  watches are owner-only by trust (recommend yes).
- **Briefing default cadence and opt-in:** weekday-morning default, off until opted in — confirm.
