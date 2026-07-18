# Long-running chat: one thread + auto-recall

Design for a single, effectively forever-running chat that never grows the model context without
bound. The live prompt stays a bounded recent window; older discussion is reached back into on
demand through the pgvector store we already populate. "Topics" are a soft, derived label over the
one thread — **not** separate hidden conversations behind a router.

Status: **Phase 1 (auto-recall layer) is implemented** — see the rollout section. Phases 2–4 remain
design. Integration points below are the contract for the work that follows.

## Goal / non-goals

**Goal.** The owner keeps talking in one continuous chat. When the current message relates to
something discussed long ago (outside the recent window), the relevant earlier discussion is pulled
back into context automatically, summarized, without the owner having to search for it.

**Non-goals.**

- Not a literal forever-context — we never hand the model an ever-growing message list (see below).
- Not a topic router that files each message into a hidden per-topic conversation. We considered it
  and rejected it (see *Rejected: hidden threads + router*).
- Not a change to how untrusted (email/SMS-from-strangers) tasks build context — recall is
  owner-privileged only.

## The bad version we are explicitly avoiding

A single ever-growing prompt fails three ways: unbounded cost, unbounded latency, and *context rot*
— models get **worse** with very long, low-signal context, not better. The whole point of this
design is bounded live context + retrieval, never "just keep appending."

## What already exists (this design mostly wires it together)

| Capability | Where | Reused as |
| --- | --- | --- |
| Bounded live window | `apps/web/app/api/chat/route.ts` (`MODEL_HISTORY_LIMIT = 40`, `boundedModelHistory`); executor `.slice(-20)` at `packages/core/src/workflow/executor.ts:487` | The live context. Unchanged. |
| Per-message embeddings + HNSW index | `packages/db/src/schema.ts:133-155` (`messages.embedding vector(1536)`, async backfill index) | The recall store. |
| Semantic search over past chats | `conversations.search`, `packages/tools/src/builtin/index.ts:504-543` | The retrieval query, promoted from a model-invoked tool to automatic injection. |
| Durable-fact recall + owner card | `memory.recall` (`builtin/index.ts:372-409`), `getOwnerCard`, consolidation in `packages/core/src/memory/` | Complementary; recall of *episodes* is what this adds. |
| Trust gating of private context | `executor.ts:1057-1058,1072` (`privilegedTask && !state.untrustedContext`) | The gate recall must copy. |

The materials are in place. The gap is: (1) `conversations.search` only fires if the *model chooses*
to call it — we want relevant history injected automatically; and (2) the retrieval unit (isolated
messages) is too noisy to inject blindly.

## Architecture

### One thread, soft segments

Everything stays in one `conversations` row. A **segment** is a contiguous run of messages on one
topic within that thread — a derived index, never a separate conversation. Wrong segment boundaries
only slightly degrade retrieval; they can never misfile the live conversation. That reversibility is
the entire reason we prefer this over a router.

### Retrieval unit — segments, not lone messages

Injecting individual matched messages is noisy: `"yes, do that"` embeds poorly and means nothing out
of context. Two tiers:

- **Tier 1 (ship first, no schema change).** Match the incoming message against existing
  `messages.embedding`. For each hit, expand to its *neighborhood* (the matched message ± a few
  adjacent messages in the same conversation) and dedupe overlapping neighborhoods. Inject the
  neighborhood, not the lone line.
- **Tier 2 (durable answer).** A `conversation_segments` table holds a rolling summary + one
  embedding per segment. Recall matches *segment-summary* embeddings and injects the summary
  (optionally plus 1–2 verbatim key lines). Summaries retrieve far better than raw turns and are
  cheaper to inject.

### Automatic recall, each owner turn

Before building the model context:

1. Embed the incoming user message (injected embed fn, same pattern as tools' `deps.embed`).
2. Retrieve top-K segments/neighborhoods that are **older than the live window** and score **≥ τ**
   cosine similarity.
3. If nothing clears τ, inject nothing. A fresh topic must not drag in stale, loosely-related
   history — "no false memories" is a hard property, not a nicety.
4. Build a compact **Relevant earlier context** block: per segment, a dated one-line summary and at
   most 1–2 verbatim lines. Hard-cap the whole block (≈ K ≤ 5 segments, ≤ ~1.5–2 KB).
5. Inject via `buildSystemPrompt` extras (same mechanism as `ownerCard`, `chat.ts:73-79`) or as a
   leading system chunk. Recommend the extras path so both chat routes share it.

### Window exclusion (critical)

Recall must exclude anything already in the live tail — match only messages with `createdAt` older
than the oldest message in the current window (or by segment non-overlap). Re-injecting recent
context wastes the budget and teaches the model nothing.

### Trust gating (critical)

Recall injects owner-private history, so it runs **only** when `privilegedTask && !untrustedContext`
(mirror `executor.ts:1057-1058,1072`). An email-triage or unknown-sender task never receives it.

### Shared implementation point

Put the logic in core — e.g. `packages/core/src/memory/recall.ts`, `recallRelevantContext({ db,
agentId, conversationId, queryText, window, embed, trust })` → a bounded string block or `null`.
Both callers use it:

- **Streaming path:** `apps/web/app/api/chat/route.ts` — after `boundedModelHistory` (~line 215),
  feed the block into `buildSystemPrompt(agent, { ownerCard, recall })` at ~line 299.
- **Executor path:** `packages/core/src/workflow/executor.ts` — system assembly at line 1070; the
  query is the latest user turn from the window built at line 487.

## Schema

Tier 1 needs **no** schema change (reuses `messages.embedding`).

Tier 2 adds one table (sketch):

```
conversation_segments
  id                uuid pk
  agent_id          uuid → agents
  conversation_id   uuid → conversations
  start_message_id  uuid → messages
  end_message_id    uuid → messages
  summary           text
  embedding         vector(1536)          -- hnsw vector_cosine_ops, matches existing dim
  message_count     int
  started_at        timestamptz
  ended_at          timestamptz
  created_at / updated_at
  -- index: (agent_id, conversation_id, started_at); hnsw on embedding
```

Optional convenience: a nullable `messages.segment_id`. Not required if ranges live on the segment
row.

## Segmentation (soft, offline)

Segments are computed by the existing maintenance/consolidation pass (`packages/core/src/workflow/
maintenance.ts`, `packages/core/src/memory/consolidation.ts`), never on the hot path. Boundary
heuristic, cheapest first:

1. **Time gap** — a long quiet gap starts a new segment.
2. **Embedding drift** — cosine distance between consecutive message-windows crossing a threshold.
3. **LLM boundary/summary pass** (low cadence) — the `classify`/`extract` roles already exist; use
   them to place boundaries and write the rolling summary.

Start with (1)+(2) to bootstrap, layer (3) for summary quality. Re-segmentation is idempotent and
safe to re-run.

## Failure modes & mitigations

| Risk | Mitigation |
| --- | --- |
| Recall miss feels like amnesia | Keep `conversations.search` available as an explicit tool; Tier-2 summaries lift recall over raw-message matching. |
| Irrelevant history injected (distraction) | τ threshold + hard K/byte caps; inject nothing when nothing clears τ. |
| Re-injecting recent context | Window-exclusion by `createdAt`/segment non-overlap. |
| Leaking private context into untrusted tasks | Gate on `privilegedTask && !untrustedContext`. |
| Embedding lag on new messages | Recall only needs *older* messages, which are already backfilled; recent turns are in the live window regardless. |
| Wrong segment boundaries | Soft degradation only — never misfiles the live thread (the router failure mode we avoided). |

## UX (phase 3, described not yet built)

`/chat` opens one canonical **primary** thread by default (mark via `conversations.metadata.primary`
or a dedicated column, resolved/created in `ensureChatConversation`). The existing chat list stays
reachable as "All chats"; archive/restore (`route.ts:192-197`) is unchanged. Optionally surface a
small "pulled in an earlier discussion from {date}" affordance for transparency when recall fires.

## Integration with goals, tasks, retries, approvals

Recall is additive context injection — it does not touch the task state machine, so everything that
runs on tasks keeps working unchanged:

- **Async / running tasks** carry a `conversationId` (`schema.ts:170`) and post their result back
  into that conversation (`chat.ts:254-263`). Work kicked off from the primary thread reports into
  the primary thread.
- **Retries** are task-level and crash-safe — `attempt`, `maxSteps`, the `lockedUntil` lease, and
  the checkpointed `state.contextWindow` (`schema.ts:192-197`). They resume from checkpoint
  independent of how the chat window is assembled. Recall never rewrites history or gates execution.
- **Approvals, budget guards, missions** all hang off a task → conversation. Unchanged.

**Seam — autonomous work runs in its own threads today.** A goal creates a separate conversation
titled `"Work: {goal.title}"` with `metadata.goalId` (`apps/web/app/goals/actions.ts:112-121`); a
mission reports progress into *that* conversation (`packages/core/src/workflow/missions.ts:240-251`),
not the primary chat. Two ways to reconcile with "one discussion":

- **A (recommended).** Keep work threads separate but reachable. The primary thread's auto-recall
  spans all threads (embeddings are channel/thread-agnostic), so asking about a goal in the primary
  thread surfaces the mission's latest update — without a chatty mission flooding the main feed.
- **B.** Route mission `report()` into the primary thread so background progress appears inline. More
  "single feed," but a noisy mission spams the main conversation. Layer on later as opt-in per goal.

Identity is already unified independent of this — one agent, one owner card (`chat.ts:73-79`), one
voice profile — so it already *talks* like one person. Single-thread + recall adds the continuous
*memory* to match.

## Rejected: hidden threads + router

Auto-creating a conversation row per topic behind one UI, with a classifier routing each incoming
message, was considered and rejected. A misrouting classifier fragments one topic across threads or
merges two unrelated ones — and it does so on the *live* conversation where the mistake is visible
and hard to undo. It adds a stateful failure mode for the same user-visible outcome that retrieval
already delivers. Retrieval, not physical thread-splitting, is what makes an old discussion resurface.

## Cost

One embed call per owner turn (already metered through the cost ledger, `cost_events` source
`embedding`). Tier 2 adds periodic summary generation in the offline pass. Injected recall is capped,
so per-turn model cost stays bounded — this design *reduces* worst-case cost versus any
grow-the-prompt approach.

## Rollout

- **Phase 0 — this doc.** ✅
- **Phase 1 — recall layer, no schema change. ✅ Implemented.** `recallRelevantContext()` +
  `recentWindowStart()` in `packages/core/src/memory/recall.ts` over existing message embeddings
  (neighborhood + dedupe), pulling only from owner/assistant-trust threads. Injected via a `recall`
  extra on `buildSystemPrompt` (`chat.ts`), wired into the streaming path
  (`apps/web/app/api/chat/route.ts`) and the executor chat-turn path
  (`packages/core/src/workflow/executor.ts`, gated on `privilegedTask && !untrustedContext`). Behind
  the `CHAT_RECALL_ENABLED` flag (off by default). Covered by
  `packages/core/src/memory/recall.test.ts` (window exclusion, similarity threshold, trust filter,
  neighborhood expansion, dedup). Next: turn the flag on and measure recall hit-rate and injected
  size before starting Phase 2.
- **Phase 2 — segments.** `conversation_segments` + rolling summaries + boundary detection in the
  maintenance pass; switch recall to segment summaries.
- **Phase 3 — single-thread UX.** `/chat` → primary thread; list becomes "All chats."
- **Phase 4 (optional) — transparency affordance** in the UI.

## Test plan

- Unit: window-exclusion drops in-window messages; τ threshold with no qualifying history injects
  nothing; trust gate omits recall for untrusted tasks; byte/K caps hold.
- Integration: raise a topic, bury it under 50+ unrelated turns, raise it again → the earlier
  discussion is injected and the answer reflects it.
- Negative: a genuinely new topic injects nothing (no false-memory bleed).

## Open questions

1. Segment boundaries: ship heuristic-only (time + drift), or gate phase 2 on the LLM pass for
   summary quality?
2. Primary-thread migration for the existing multi-chat history — pick an existing chat as primary,
   or start a fresh primary and leave old chats in "All chats"?
3. τ and K defaults — set from a measurement pass in phase 1 rather than guessed here.
4. Autonomous-work threads — recall-only (option A) to start, or route mission updates into the
   primary thread (option B)? Recommend A first, B as later per-goal opt-in.
