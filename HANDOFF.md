# Firestore migration handoff (cloud → local, 2026-09-25)

Production still runs on PostgreSQL. Nothing in this session touched production or any cloud database.

## 1. PRs ready to merge (CI green on their current head)

Merge these in any order. After each merge, the others may need `git merge origin/main` (usually union conflicts in `scripts/test-firestore.ts`, `apps/web/lib/server.ts`, `apps/web/proxy.ts`, and the inventory docs).

| PR | What |
|---|---|
| #388 | Web: device registration, readiness, SQL-free routes |
| #390 | Agent: open-loop sweep job |
| #391 | Agent: ambient refresh job (conflicts with #390 in `packages/core/src/memory/jobs.ts` and `packages/firestore/src/execution.ts`; re-merge main after the first lands) |
| #392 | Web: memory organization + long-term memory erasure |
| #393 | Agent: health monitor job |
| #394 | Web: person delete and merge |
| #395 | Web: /profile memory hub |
| #396 | Web: owner artifact downloads |
| #360 | Codex: Firestore text document uploads (CI failure fixed in `05dd86a6`; confirm CI is green) |
| #362 | Codex: web.fetch + workspace.* tools under Firestore |
| #397 | Agent: remaining built-in tools (graph snapshot, read_result, occasions, contacts, conversations.search, situations) |
| #398 | Web: knowledge workspace, map, cleanup, entity edits, relation correct, /profile/knowledge |
| #399 | Agent: goals/missions, Notifications-conversation delivery, goal-blocked, goal sessions under Firestore |

## 2. Work-in-progress branches (pushed as WIP; no PR yet unless noted)

| Branch | Pushed | State | Next step |
|---|---|---|---|
| `claude/firestore-agent-proactive-jobs` | `3af9fbdc` | `memory.extract` ported (persistence port + Firestore adapter, lease-fenced per-conversation checkpoint, added to the Firestore-ready job list). Only `tsc` for core run; untested. | Write `apps/agent/src/firestore-memory-extraction.test.ts` (pattern: `firestore-open-loop-sweep.test.ts`; fake router, throwing SQL proxy; reclaim case: fail on 2nd conversation, expire lease, reclaim, assert 1st not re-sent and old lease can't write). Add composite index for messages `role in` query, add to `scripts/test-firestore.ts`, update inventory. Then `briefing.compose`, `pulse.check`, `chat.segment`, `memory.graph_date_backfill`. |
| `claude/firestore-module-sms` | `4f631056` | Nudge policy only: port `packages/persistence/src/nudge-policy.ts`, PG `packages/db/src/nudge-policy-repository.ts`, Firestore `packages/firestore/src/nudge-policy.ts` (per-owner lock doc), core `evaluateOutOfBandPing` delegates; shared contract `packages/persistence/src/nudge-policy-contract.ts` not yet wired. Not typechecked or tested. | Add PG + Firestore test files running the contract, typecheck. Then SMS: inbound webhook idempotent by MessageSid, approval-code replies, final delivery, channel rate limit, voice context, notifier wiring in `apps/agent/src/deps.ts`, indexes, allow `sms` in `validateAgentPersistenceConfig`. |
| `claude/firestore-module-google` | = main (no changes) | Research only. Refresh token comes from `BOT_GOOGLE_REFRESH_TOKEN` config (no DB table). | In `packages/modules/src/google/email-sync.ts`, move storage calls in `syncMailboxOnce`/`processMessage` behind a new `packages/persistence` repository; replace `syncMailboxWithDistributedLock` (~line 1312) with a Firestore lease document + fencing token; cursor and processed-message records must commit in one transaction (needs a transaction-accepting task create). Then `email.extract`, email delivery, `gmail.send` voice rewrite, `drive.ingest`, `applications.*`. |
| `claude/firestore-agent-sweep-callbacks` | `9cc8d47e` | Nearly done. Firestore maintenance repository runs every remaining sweep step (suggestions, stalled attention, budget notices, embedding backfill in configured space, both purges); `findDueTasks` intentionally not ported (every runnable transition writes a durable wake intent). Browser/code callbacks go through a new execution-jobs callback command (PG + Firestore). Tests listed, inventory updated. Lint, typecheck, PG 1812 passed; `test:firestore` 565/566 (one timeout in `firestore-graph-sync.test.ts` that passes alone). Last small edit to `packages/firestore/src/maintenance.ts` only focus-tested. search, maps, browser, code modules now eligible for the allowlist (unchanged). | Rerun `pnpm lint` and the maintenance tests, open the PR. Then relax `validateAgentPersistenceConfig` for search/maps/browser/code in a separate PR. |
| `claude/firestore-imports` | `32fc1137` | Nearly done. Firestore `import.run` and `voice.ingest` (batch + checkpoint lease-fenced), enabled under Firestore; upload/start/purge/delete/review on web + mobile, routes allowed in `apps/web/proxy.ts`; indexes; emulator tests (upload→run→review→purge, retry, lease reclaim, voice ingest). Lint, typecheck, touched tests pass. | Update both inventory docs. Fix: under Firestore a voice upload via `/api/import/upload` redirects to `/profile`, which is still proxy-blocked (lands after #395 merges, or redirect elsewhere). Run full PG suites for touched packages + `pnpm test:firestore`, open the PR. |

Resume each branch with: `git fetch origin <branch> && git switch <branch>`, read the last commit message and the task brief below, finish, verify, open the PR.

## 3. Not started

- Proactive jobs batch 2: `anomaly.scan`, `skill.reflect`, `self.improve`, `dream.run`, `self.maintain`, `graph.curiosity` (`packages/core/src/memory/jobs.ts`, remove from `firestoreCodeJobUnavailable` once ported).
- Documents module: `documents.search` (pgvector chunks), `documents.process`, `/webhooks/document/callback`, document delete (after #360 merges).
- Push module + device tokens in the notifier (after #388 merges); reuse the nudge gate from the SMS branch.
- Location webhook + canaries in the agent (web location is done).
- Web: `model_role` improvement apply, remaining `/chat/[id]` degraded bits, and the structural gap: `apps/web/lib/server.ts` still statically imports `@assistant/db` (see end of `docs/firestore-web-route-inventory.md`).
- Relax `validateAgentPersistenceConfig` (apps/agent) per module only once every row for that module in `docs/firestore-agent-runtime-inventory.md` is Ready.

## 4. Small follow-ups

- `apps/web/app/profile/memories/page.test.tsx:160` expects `'one matching configured owner'`, but the page now throws `'Memory hub requires exactly one configured agent'`. The fence works; only the assertion is stale. The file is missing from `scripts/test-firestore.ts`, so CI never runs it. Fix the assertion, add the file to the list, and check for other emulator-only tests missing from the list.
- After #399 merges: `packages/firestore/src/watches.ts` `ensureNotifications` creates the Notifications chat without #399's uniqueness record. Route it through the new command.
- The latency of #398 knowledge reads on production-sized data is unmeasured (earlier Firestore Knowledge endpoint ~11 s).

## 5. Owner-only steps (need your gcloud + Neon API key; cannot run in the cloud container)

After all code is merged:

1. Deploy a private Firestore canary from the release commit and run the PostgreSQL-offline rehearsal with all modules enabled (`docs/firestore-rehearsal-2026-09-23.md` for the previous one).
2. Rehearse the Neon fence on a disposable branch (`docs/firestore-source-write-fence.md`).
3. Run `pnpm cutover` (15 steps, `docs/firestore-cutover-checklist.md`).
4. After ≥168 h on Firestore: `pnpm cutover:retirement-report ... --live`. Only a READY verdict makes deleting the Neon database safe. You must record accepted-loss decisions for the 5 unrecoverable asset references and a separately retained, restore-tested PostgreSQL archive.

## Local test environment

```sh
pnpm install --frozen-lockfile
# Firestore emulator (needs Java 21):
npx firebase-tools setup:emulators:firestore
java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-*.jar --host 127.0.0.1 --port 8789 &
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8789
export TEST_DATABASE_URL=postgres://assistant:assistant@localhost:5432/assistant_test   # pgvector required
pnpm lint && pnpm typecheck && pnpm test:firestore && pnpm test
```
