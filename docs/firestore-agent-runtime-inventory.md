# Firestore agent runtime inventory

Updated 2026-09-24. This lists every capability the production agent (`apps/agent`) enables and records whether it runs with zero SQL access when `PERSISTENCE_DRIVER=firestore` selects the Firestore composition in `apps/agent/src/deps.ts`. **Production still runs on PostgreSQL.** This inventory covers the agent only. Web and mobile routes are tracked separately.

Production composition: `assistant.config.ts` composes 11 modules, and `infra/gcp/deploy.sh` defaults `ASSISTANT_MODULES=all`. The agent runs with `QUEUE_DRIVER=cloudtasks`, one Cloud Scheduler `/internal/sweep` job per minute, Gmail sync/watch scheduler jobs, and optional canary jobs. `packages/db/src/seed.ts` seeds 19 proactive schedules.

## Classification

- **Ready**: a Firestore adapter is selected in the Firestore composition, and an emulator test exercises it with a throwing SQL proxy.
- **Disabled**: `validateAgentPersistenceConfig` refuses the setting, or the Firestore composition deliberately does not register or run the path. It cannot reach SQL. It is also unavailable to the owner.
- **SQL**: the code path still calls PostgreSQL. It would hit the `unavailableSqlDb()` tripwire if Firestore mode reached it.

Today `validateAgentPersistenceConfig` restricts Firestore agent mode to `ASSISTANT_MODULES` ⊆ `{reminders, calendar}`, `QUEUE_DRIVER=local`, `CANARY_ENABLED=false`, and an empty `LOCATION_PING_SECRET`. Anything outside those limits is **Disabled** by configuration, even where parts of it are ported.

## Process and dispatch

| Path | State | Notes |
|---|---|---|
| Boot (`buildFirestoreDeps`), `/health`, `/ready` | Ready | `firestore-boot.test.ts` spawns the process with an unreachable `DATABASE_URL`. No SQL client is constructed. |
| Local poller claim/drain (`QUEUE_DRIVER=local`) | Ready | Fenced by owner readiness. Claims only the configured agent. |
| `/internal/tasks/execute` (Cloud Tasks delivery) | Ready (route) | Runs the same `executeAgentTask`. |
| Durable outbox → Cloud Tasks dispatcher | SQL-free but **not wired** | `dispatchOutbox` + `FirestoreOutbox` exist and are emulator-tested (`firestore-dispatch.test.ts`), but no route or poller runs them. So Firestore mode requires `QUEUE_DRIVER=local`, and the local poller is the single dispatcher. A Cloud Tasks deployment needs one scheduled dispatcher route. |
| Canaries (`/internal/canaries/*`, browser canary webhook) | Disabled | Return 501 in Firestore mode. `canary_runs` is SQL. |
| Location webhook (`/webhooks/location`) + arrival nudge | Disabled | `recordLocationPing` and `maybeEnqueueArrivalNudge` are SQL. Firestore requires an empty `LOCATION_PING_SECRET`. |
| Vertex model probe | Ready | Firestore-only route. |

## Executor (general model loop)

| Path | State | Notes |
|---|---|---|
| Claim, checkpoint, sleep/park/complete, retries, dead letter | Ready | `ExecutionPersistence.tasks`. |
| Seed/context window, owner replies while parked | Ready | `executionContext`. |
| Planner, owner card, ambient, commitments, skills, history/graph recall, recall metrics | Ready | `firestore-executor.test.ts`, `firestore-chat.test.ts`. |
| Tool dispatch, approvals, policies, cost reservations, idempotency, cache | Ready | `dispatcher.firestore.test.ts`, `firestore-approval.test.ts`. |
| Browser/code job staging and settle | Ready | `executionJobs`. |
| Final delivery to the task's own chat, generated cards, response checks | Ready | |
| Final delivery for a conversation-less assistant task (e.g. seeded `tomorrow-check`) | SQL | `getOrCreateNotificationsConversation(db)` in `executor/finalize.ts`. |
| Goal-blocked write (`recordGoalBlocked`) | SQL | `goals` update in `executor/notices.ts`. Reached by unattended goal sessions. |
| Missions (`startMission`, `wakeMission`) | SQL | `missions` domain. |
| Save-status answers | Ready | |

## Code jobs (`packages/core/src/memory/jobs.ts`)

| Job | Seeded schedule | State |
|---|---|---|
| `reminder.notify` | per reminder | Ready (PR #368, `firestore-reminder-delivery.test.ts`) |
| `memory.consolidate` | memory-consolidation | Ready (`firestore-memory-consolidation.test.ts`) |
| `memory.graph_sync` | knowledge-graph-sync | Ready (`firestore-graph-sync.test.ts`) |
| `documents.extract` | per upload | Ready (`firestore-document-extraction.test.ts`). The upload path is in PR #360. |
| `watch.suggest` | per watch fire | Ready. It uses only `persistence.watches/messages/executionContext`. |
| `memory.extract` (+ commitments) | memory-extraction | SQL |
| `memory.sweep_loops` | open-loop-sweep | SQL |
| `email.extract` | email-extraction | SQL |
| `briefing.compose` | daily-briefing | SQL |
| `pulse.check` | pulse (every 20 min) | SQL |
| `graph.curiosity` | knowledge-graph-curiosity | SQL |
| `memory.graph_date_backfill` | knowledge-graph-date-backfill | SQL |
| `chat.segment` | chat-segmentation | SQL |
| `anomaly.scan` | anomaly-scan | SQL |
| `skill.reflect` | skill-reflection | SQL |
| `self.improve` | self-improve | SQL |
| `ambient.refresh` | ambient-refresh (every 30 min) | SQL |
| `dream.run` | dream | SQL |
| `self.maintain` | self-maintain | SQL |
| `health.monitor` | assistant-health-monitor | SQL |
| `documents.process` | document-processing (every 15 min) | SQL |
| `import.run`, `voice.ingest` | on demand | SQL |

Imported installations carry these schedules. In Firestore mode an SQL job's task fails on the tripwire, retries, and dead-letters with an owner notice. They must be either ported or explicitly skipped at the schedule runner.

## Maintenance sweep (`/internal/sweep` and local poller)

| Step | State |
|---|---|
| `expireStaleApprovals`, `resumeResolvedApprovalTasks`, `renotifyStalledApprovals` | Ready |
| Watch expiry (`persistence.watches.expire`) | Ready |
| `runDueSchedules` (portable runner) | Ready. Goal-linked schedules reject without a goal adapter. |
| Stale cost-reservation release (`purgeExpired` → `releaseStaleReservations`) | SQL-only today. `FirestoreCostRepository.releaseStale` exists but is not run, so held reservations are never released in Firestore mode. |
| `expireStaleSuggestions`, `renotifyStalledAttention`, `emitBudgetNotices`, `backfillMessageEmbeddings`, `purgeExpired` (rest), `purgeAgedHistory`, `findDueTasks` backstop | SQL. The local drain covers `findDueTasks`. |
| Module sweep steps: watches `reapExpiredWatches`, `pollWebWatches` | Portable code, but **not run** in Firestore mode (the Firestore branch skips module sweep steps). |
| Module sweep step: google `reapExpiredApplicationWatches` | SQL |
| Module poller ticks: google `email-sync` | SQL. It is not gated by persistence driver; the module is currently disabled by configuration. |

## Modules

| Module | Boot | Tools | Hooks / background | State |
|---|---|---|---|---|
| reminders | Ready | `reminder.create/list/cancel` Ready | Delivery Ready (#368) | **Ready** (allowed) |
| calendar | Ready | `calendar.*` reads (HTTP only) Ready | none | **Ready** (allowed) |
| watches | Ready | `watch.create/list/cancel/web` Ready | email observers need google; sweep steps portable but not run | Disabled (config) |
| search | Ready | `web.search` SQL. It only records cost via `recordCostEvent(ctx.db)`. | none | Disabled (config) |
| maps | Ready | `maps.directions` SQL, but only for current-location origin (`latestLocation(ctx.db)`) | none | Disabled (config) |
| browser | Ready | `browser.plan/execute` staging Ready | `/webhooks/browser/callback` → `recordBrowserJobResult(db)` SQL | Disabled (config) |
| code | Ready | `code.execute` staging Ready | `/webhooks/code/callback` → `recordCodeJobResult(db)` SQL | Disabled (config) |
| documents | Ready | `documents.search` SQL (pgvector chunks) | `/webhooks/document/callback`, `documents.process` SQL; `documents.extract` Ready | Disabled (config) |
| push | Ready | none | owner notifier: device tokens via `getAgent`/`listActiveDeviceTokens(db)` SQL | Disabled (config) |
| sms | Ready | `sms.send` voice rewrite (`loadVoiceContext(db)`) SQL | inbound `/webhooks/twilio/sms`, approval codes, final delivery, notifier: SQL | Disabled (config) |
| google | Ready | Gmail/Docs/Sheets/Slides/Calendar HTTP tools; `gmail.send` voice rewrite SQL; `drive.ingest` SQL; `applications.*` SQL | Gmail Pub/Sub + sync + watch renewal (distributed lock on a reserved PG connection), email channel delivery, application confirmations: SQL | Disabled (config) |

Owner notifications in Firestore mode post to the dashboard only (`firestoreDashboardOwnerNotifier`). The out-of-band SMS/push legs and the nudge-policy gate (`evaluateOutOfBandPing(db)`) are SQL.

## Built-in tools

The Firestore composition registers `memory.save`, `memory.recall`, `task.schedule`, `goals.update_progress`, `owner.notify`, and (opt-in, non-production) MCP tools. PR #362 (Codex, open) adds `web.fetch` and `workspace.read/write/list`.

| Tool | State |
|---|---|
| `weather.lookup` | SQL only for the current-location fallback (`latestLocation(db)`); the rest is HTTP |
| `sports.scores` | SQL only for the owner timezone (`getAgent(db)`) |
| `memory.graph_snapshot` | SQL (pgvector join) |
| `tools.read_result` | SQL (`tool_calls`) |
| `occasions.save/list`, `contacts.lookup`, `conversations.search` | SQL |
| `goals.list`, `goals.create`, `mission.update` | SQL |
| `situations.read/decisions/sources/change` | SQL |

## Remaining work, in dependency order

1. Run the portable maintenance paths the Firestore sweep skips: stale reservation release and the watches module steps. Gate SQL-only module ticks and sweep steps by driver.
2. Refuse SQL-only code jobs explicitly in Firestore mode (schedule skip and benign completion) until each is ported, instead of tripwire dead letters.
3. Port the thin SQL reads in otherwise portable tools: weather/maps current location (`ownerContext.getLatestLocation`), sports timezone, and `web.search` cost recording (`CostRepository.record`).
4. Port the Notifications-conversation final delivery and the goal-blocked write in the executor.
5. Port browser/code job callbacks (`recordBrowserJobResult`, `recordCodeJobResult`) to an execution-jobs callback command.
6. Wire the Firestore outbox dispatcher for `QUEUE_DRIVER=cloudtasks`, with exactly one dispatcher active.
7. Large domains, each needing its own repository family: Gmail sync/ingest/delivery (google), SMS channel and approval codes, push device tokens and nudge policy, documents search/processor, missions, goals list/create, occasions/contacts/conversation search, situations, the remaining proactive code jobs, location ingest, and canaries.

Relaxing `validateAgentPersistenceConfig` for a module is safe only once every row for that module above is Ready.
