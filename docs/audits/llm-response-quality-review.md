# LLM response quality and proactivity review

A review of everything the installation can expect to come out of a model: what
is asked for, what comes back, what checks it, and what the owner ever sees. It
was commissioned to answer two questions — why answers are sometimes wrong or
badly formed, and why the assistant is quieter than its design documents claim.

Grounded in the code as of "Port task creation and durable queue dispatch behind
persistence contracts" (#127).

**Coverage.** Three of five planned tracks completed: the synchronous response
path, inbound signal (mail/calendar/SMS/push/location), and a full model-call
inventory. Two tracks — memory/context assembly and evaluation-infrastructure
coverage — were cut short and are **not** represented here beyond what the other
tracks touched. Their absence is noted rather than papered over; the open
questions at the end say what was not looked at.

## Verdict

Three findings account for most of the gap between the assistant this repository
describes and the one an owner experiences.

1. **The default mail mode disables almost all proactive mail behavior.** One
   enum default (`EMAIL_INGEST_MODE=direct`) leaves the table that every mail-driven
   proactive surface reads permanently empty. This is not a quality problem to be
   tuned; it is a switch that is off.
2. **Factual grounding is strong where it was built and absent where it was not.**
   Calendar and email answers are verified word-by-word against the tool ledger.
   Web and weather answers — the categories that failed the September audit — have
   no deterministic check at all.
3. **Nothing records what the model actually said.** The `model_calls` ledger
   stores cost and token counts, not prompts or outputs. No quality question about
   production can currently be answered from data.

The system's engineering is not weak. `groundReadDraft`, the unsupported-claim
regex family, `validateGroundedCard`, `enforceUrlProvenance` and the request
checklist are real, code-based guarantees of a kind most assistants do not have.
The problem is that this rigor is unevenly applied, and that its coverage is
invisible because the output it guards is never stored.

## 1. One seam, thirty surfaces

Every model call in the application goes through `ModelRouter`
(`packages/core/src/model-router/router.ts`). Its entire generative API is
`generate` (:601), `stream` (:655), `step` (:750), `object` (:870) and `embed`
(:978), over eight roles (`ModelRole`, :25).

Thirty generative call sites exist. The ones on the owner-visible path:

| Surface | file:line | Role |
| --- | --- | --- |
| Chat reply (primary) | `packages/application/src/chat-turn.ts:596` | draft |
| Chat needs-action triage | `packages/application/src/chat-turn.ts:389` | classify |
| Agent step loop (×4) | `packages/core/src/workflow/executor/step-loop.ts:757,813,853,882` | dynamic |
| Planner — plan | `packages/core/src/workflow/planner.ts:231` | plan |
| Planner — trivial triage | `packages/core/src/workflow/planner.ts:215` | classify |
| Output verification | `packages/core/src/workflow/output-verification.ts:142` | rewrite |
| Briefing compose | `packages/core/src/workflow/briefing.ts:671` | draft |
| Watch suggest | `packages/core/src/workflow/watch-suggest.ts:72` | draft |
| Email importance | `packages/modules/src/google/email-importance.ts:169` | classify |
| Email automated triage | `packages/modules/src/google/email-sync.ts:331` | classify |
| Email extraction | `packages/core/src/memory/email-extraction.ts:190` | extract |
| Commitment extraction | `packages/core/src/memory/commitments.ts:125` | extract |

The remaining eighteen are memory, card, browse, mission, dream, improve,
self-maintenance, skill-reflect and voice surfaces.

That a single class sees all thirty is the most useful architectural fact in the
codebase for this purpose: quality instrumentation needs one seam, not thirty.

### Surfaces that contain no model at all

The two highest-frequency proactive producers are deterministic:

- `packages/core/src/proactive/pulse.ts` — the `*/20 * * * *` job. Its own comment
  at :121 reads *"What the owner is told. Deterministic: no model composes this."*
- `packages/core/src/proactive/curiosity.ts` — gaps come *"from rows, never from a
  model's imagination"* (:13).

`calendar-salience.ts`, `arrival.ts` and `nudge-policy.ts` are likewise pure code.

This is a deliberate and defensible safety design: a code job holds no tools, so
untrusted mail cannot act, and nothing can invent urgency. It is also the likely
reason proactive messages read as templated. The improvement that preserves the
property is narrow — let a model **phrase** what deterministic code **decided**,
never let it decide. `briefing.ts` already works exactly this way (`briefing.ts:33`:
the model *"is never asked what it"* — the notes are assembled first), so the
pattern exists in-repo and does not need inventing.

## 2. The default mail mode is the proactivity bug

`EMAIL_INGEST_MODE` defaults to `direct` (`packages/config/src/index.ts:215`,
`.env.example:204`).

The only production writer of the `email_ingest` table is `email-sync.ts:617`,
inside `processForwardedIngest` — the **forwarded**-mode path. In `direct` mode
that table is never written.

Everything mail-driven and proactive reads that table:

| Consumer | Reads | Effect in `direct` mode |
| --- | --- | --- |
| Pulse mail-action moment | `pulse.ts:376` | never fires |
| Importance scoring | `email-importance.ts` | never runs |
| Deterministic important-mail ping | `email-sync.ts:661-672` | never fires |
| `email.extract` memory job | `email-extraction.ts:141-154` | walks an empty table |
| Briefing mail highlights | `briefing.ts` | nothing to highlight |

So in the shipped default, the assistant's only reaction to mail is to drop it or
spend a sixteen-step triage task on it. The entire deterministic scoring, notify,
digest and memory pipeline is inert.

Worse, `direct` mode drops automated senders **before any model call**, on this
regex (`email-sync.ts:328`):

```
/no-?reply|notifications?@|newsletter|mailer|donotreply/i
```

That matches most airline, hotel, bank and ticketing senders — exactly the flight
and booking confirmations a personal assistant exists to notice. The message is
discarded with a `console.log`: no ledger row, nothing searchable, nothing
recoverable, nothing the owner can ever see.

`docs/anticipation-layer.md` already names this failure mode in the abstract
("an owner who forwards their inbox here has that mail dropped… the importance
alerts, briefing highlights and proposed dates all silently never happen") and
`proactiveConfigNotes` was built to warn about it. The finding here is stronger
than the doc's: it is not only forwarded inboxes that lose mail, it is the
**default configuration** that disables the pipeline.

**This is the single highest-leverage change available.** It is also a product
decision, because changing a default changes behavior for existing installs —
see the open questions.

## 3. Grounding is strong where built, absent where not

`groundReadDraft` (`response-contract.ts:1325-1516`) verifies a calendar or email
answer against the literal tool ledger: every returned event title must appear,
every stated clock time must match a real event boundary, proper-noun runs must
come from the evidence vocabulary. On failure there is a deterministic template
fallback that cannot lie. This is the best-engineered part of the system and the
model for what is missing elsewhere.

It is reached from exactly one place — `enforcePersonalReadGrounding`, called at
`response-contract.ts:2006` — and only for a `PersonalReadRequest` (calendar,
email, drive, memory, knowledge graph).

`detectLiveLookup` (`live-lookup.ts:8-66`) covers weather and general web facts.
It is imported into `finalize.ts` but has **no grounding counterpart**.
`liveLookupFailure` (:106-118) checks only that a fetch returned a non-empty body
— never that the answer matches it.

The only remaining defense is `verifyFinalOutput`, and it is weaker than it looks:

- It is gated on `canReflect` (`executor/finalize.ts:432-435`), which requires the
  deterministic contract to have found **nothing** wrong — so it runs precisely in
  the case where nothing else caught the problem.
- It runs on `rewrite`, pinned to the cheapest tier (`model-config.ts:104`), the
  same tier as bulk classification — a weaker model reviewing a stronger model's
  work.
- It skips silently on any error or budget block
  (`output-verification.ts:151-152,160-168`).

The September failures (a stale head-of-state answer, a batted-ball statistic
reported as a score) are therefore structural rather than unlucky.

### Formatting is enforced only in the test suite

`grep -c 'fence|```' packages/core/src/workflow/response-contract.ts` returns
**0**. There is no unclosed-code-fence repair, no markdown-shape check, and no
leaked-marker strip for anything but the one `[Background notice…]` echo.

The unclosed-fence and leaked-markup checks the regression suite grades on exist
only at `packages/tools/src/question-regression/harness.ts:84-88` — test-only code.
The suite therefore grades a property the runtime never enforces, which is the
worst of both worlds: a green suite implies a guarantee that does not ship.

## 4. Nothing records what the model said

`model_calls` (`packages/db/src/schema.ts:1232-1251`) stores `role`, `model`,
`input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `finish_reason` and
`openrouter_generation_id`. It does not store the prompt or the response. The
OTel span is `withSpan('model.generate', { role, model })` (`router.ts:616`) —
the same gap.

Consequences:

- No production quality question is answerable from data. "Was last week better
  than the week before" has no source.
- Regressions are invisible until an owner notices one by hand, which is how the
  September audit happened.
- A model or routing change cannot be evaluated against real traffic, only
  against the twenty-seven scripted chat scenarios in the corpus.

These prompts contain the owner's mail and calendar, so the answer is not a naive
log. It needs opt-in capture, redaction of the evidence blocks, a retention
window and local-only storage by default. But some form of it is the
precondition for every other quality improvement here: nothing can be improved
that is not first measured.

## 5. Latency and coverage on the inbound side

Gmail is well covered: Pub/Sub push with OIDC verification, a minute-cadence
scheduler fallback, a distributed lock and a durable cursor. Worst case to
awareness is seconds to a minute.

Calendar is not. There is no `events.watch` push channel, no sync-token or
snapshot table, and no diff of one read against another. Both readers — the
07:45 briefing (36h window) and the pulse (6h window) — take a fresh stateless
snapshot. Google's `status` field is not carried through `RawEvent`
(`packages/tools/src/google/calendar.ts:31-47`) at all.

So these are structurally invisible, not merely slow:

- a meeting cancelled by its organizer
- an invite declined by someone the owner is waiting on
- a recurring instance permanently moved
- the owner's own RSVP changed from another client

And an event added ten hours out falls outside the pulse's six-hour window, so it
is not mentioned until the next morning's briefing — up to about 24 hours.

The pulse is additionally gated by a 60-minute minimum gap and a six-per-day
ambient ceiling shared across every producer (`pulse.ts:53,64`), so a busy mail
morning can silence a same-day cancellation for the rest of the day.

## 6. What is already right

Stated plainly, because a review that lists only faults misrepresents the system:

- **`groundReadDraft`** — deterministic literal-field verification with a fallback
  that cannot lie. The model for everything else.
- **Unsupported-action-claim detection** (`claimedKinds`, `enforceResponseContract`)
  — broad, carefully tuned, code-based, correctly scoped to the current task.
- **Approval-code fabrication** — fully code-defended via `isSimulatedApprovalNotice`,
  with a forced retry before a hard fallback.
- **`validateGroundedCard`** — every card fact must appear verbatim in the evidence.
- **`enforceUrlProvenance`** — rewrite-not-block guard against invented links.
- **The request checklist** — a real ledger that overrides final text when items
  are unfinished, not a prompt reminder.
- **Planner truncation handling** — a named past bug now robustly code-defended.
- **Quarantine on extracted facts** (`email-extraction.ts:73-81`) — third-party and
  unfalsifiable claims wait for review rather than entering recall.
- **The nudge ledger** — held pings are recorded with a reason and surfaced, so
  suppression is never silent loss.

## 7. Recommendations, in order

1. **Record model input and output**, opt-in, redacted, retention-bounded. Nothing
   else on this list can be verified without it.
2. **Populate `email_ingest` in `direct` mode**, or change the default. Highest
   single leverage on proactivity. (`email-sync.ts` `processMessage`, ~:916.)
3. **Persist something recoverable before the automated-sender regex drops a
   message** (`email-sync.ts:328`), so travel and billing mail is at worst
   unindexed rather than gone.
4. **Ground live web and weather answers** the way reads are grounded — a
   `groundLiveLookupDraft` parallel to `groundReadDraft`.
5. **Make the verifier unconditional on live-lookup turns**, and route it to the
   `reason` tier for `critical` turns rather than the cheapest tier.
6. **Port the harness-only formatting checks into `response-contract.ts`** so the
   suite grades a property that actually ships.
7. **Wrap `classifySender`'s model call in try/catch** (`email-sync.ts:331`). It is
   currently the only unguarded one on the ingest path, and a throw stalls the
   whole sync page behind the offending message.
8. **Add a calendar snapshot diff** and emit `event-cancelled` / `event-moved`
   moments; carry Google's `status` through `RawEvent`.
9. **De-duplicate pending approvals** for structurally identical gated calls
   (`dispatcher.ts` `parkForApproval`, ~:793).
10. **Let a model phrase the pulse's deterministic findings** — decision stays in
    code, wording comes from the model, exactly as the briefing already does.

## Open questions

Not investigated, and needed before acting on parts of the above:

- **Memory and context assembly.** What actually reaches the model's window on an
  ordinary turn, how recall selects, what truncation drops first, and whether
  superseded facts can coexist with current ones. This is usually the largest
  single driver of answer quality and it is unexamined here.
- **Evaluation coverage.** Which of the thirty surfaces any test exercises, what
  the corpus assertion vocabulary can and cannot express, and what actually runs
  in CI versus what needs a model key.
- **Whether changing `EMAIL_INGEST_MODE`'s default is acceptable** for existing
  installations, or whether `direct` mode should instead gain a lightweight
  ingest-writing path that leaves the default alone.
