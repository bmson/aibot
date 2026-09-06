# Situation packs

The first connected planning release lives at **Cards → Situation packs** on iOS and `/packs` on the web. A pack is bounded owner-private planning state, not a second task runner or scheduler.

## What is implemented

- **Situation packs:** title, up to 30 linked items and 30 decision reasons. Items can reference actual saved cards or existing commitments, or be explicitly labeled planning notes.
- **Two-sided follow-through:** Plan, I owe, and Waiting on lanes, with explicit dependencies. A changed/resolved commitment is surfaced for review; it never automatically completes dependent work.
- **Change-aware plans:** compare the saved source snapshot with the current stored card revision or commitment state. Dismissed, expired and missing sources also cause review. The existing Pulse evaluates active packs, offers an ordinary review suggestion, and reuses its pacing, unique claims and approval-protected follow-up task path.
- **Rehearsal:** before/after item and source snapshots, affected dependent items, and explicit unknowns. Preview does not modify the pack or any external system.
- **Cascading corrections:** applying a preview updates that item and transitively marks its dependents as needing review. It never changes a booking, reminder, calendar event, message or commitment. Owners review those items or ask the assistant to propose next steps.
- **Decision memory:** chosen/rejected options with reasons; situation-only is the default. Lasting preferences require explicit owner confirmation in the UI. Correcting the same literal option replaces its previous decision. Confirmed preferences survive pack archival; `forget_decision` removes an individual reason, including from an archived pack.

Both clients support creating packs, adding linked items, recording decisions, editing/rehearsing an item, applying/discarding a preview, marking dependencies reviewed and archiving a pack. “Discuss next steps” prepares a chat draft; it does not send it. Native drafts already in progress are preserved.

## Agent integration

`situations.read`, `situations.sources`, `situations.decisions`, and `situations.change` share the same core use cases as the authenticated web/mobile endpoints. Explicit pack/what-if requests use the executor, with a bounded initial pack read rather than tool-less roleplay. Prompt version 39 tells the agent to consult decision reasons and distinguish review from execution.

Tool results are untrusted data and private tools are absent from external-sender registries. Pack writes require exact approval and cannot be blanket-approved. No source text is interpolated into an executable follow-up instruction: proactive suggestions name the pack UUID and ask the ordinary executor to read its current state. Accepting a review suggestion does not authorize the proposed external actions.

Decision recall is bounded literal-word matching across the 50 most recently edited packs, returning at most 12 confirmed choices. Without a pack ID it returns only lasting preferences. An identified situation takes precedence over general preferences for the same literal option. No-match is explicitly a retrieval gap, not proof that no preference exists. It is not semantic preference inference.

## Consistency and privacy

- All rows and source references are owner-scoped. No client-supplied snapshot is accepted.
- Pack writes lock the pack row and compare versions. Editors retain their opening version, so refreshing does not silently authorize overwriting concurrent edits.
- Previews expire after 24 hours and bind the pack version plus fingerprints of all referenced sources, including a proposed replacement. Applying locks sources and rejects stale data. Repeated/concurrent Apply calls have one effect.
- Dependency cycles, missing edges, duplicate IDs, field lengths and aggregate limits are rejected.
- Sensitive card facts are excluded from planning snapshots. Stored source data never becomes an instruction.
- The existing long-term-memory export includes packs. “Forget long-term memory” removes all pack decisions and invalidates previews, while preserving explicit planning items. Archive hides a pack from active planning and change notices; it is not erasure.

## Deliberate limits

This is a grounded first release of all six concepts, not arbitrary real-world simulation. It observes **stored saved-card and commitment changes**, not every raw email or calendar modification. A reply must already have changed the linked commitment through its normal evidence/owner-confirmation flow. It does not infer travel times, fresh availability, financial consequences, or that someone fulfilled a promise. It does not automatically attach unknown dependencies or rewrite underlying sources. Those require current tool evidence and separate authorization.

Pending previews are durable and can be applied using their returned ID, but the clients do not restore an abandoned preview after reopening the screen; create a fresh preview then. Active pack lists are capped at the 50 most recently edited packs and source pickers at 100 recent records per type. Archived pack planning is read-only; decision erasure remains available through the tool.

## Verification and local QA

- Regression coverage includes graph validation, ownership, sensitive-field filtering, source races, stale versions, replay/double-tap safety, explicit preference confirmation, archival/erasure, source-change suggestion identity and UI/API shapes.
- Root `pnpm test` creates the isolated `_test` database. Do not run it while inspecting fixtures in that database.
- For a repeatable synthetic soccer-weekend fixture and browser preview/apply check:

  ```sh
  DATABASE_URL=postgres://assistant:assistant@localhost:5432/assistant_test AUTH_DEV_BYPASS=true pnpm --filter @assistant/web exec next dev --webpack --hostname 127.0.0.1 --port 3107
  DATABASE_URL=postgres://assistant:assistant@localhost:5432/assistant_test pnpm tsx scripts/visual-qa/situation-packs.ts
  ```

  The script rejects non-local/non-test databases, uses installed Chrome, and writes captures to `/tmp/assistant-packs-qa`. It adds synthetic QA records; it does not import or mutate production data or call a model.

Migration `0068_new_masque.sql` must run before deploying the server. The native app also needs a new build. No production migration, deployment, or paid model replay is part of the local QA.
