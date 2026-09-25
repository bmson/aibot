# Firestore agent runtime inventory

Updated 2026-09-25. This lists every capability the production agent (`apps/agent`) enables and records whether it runs with zero SQL access when `PERSISTENCE_DRIVER=firestore` selects the Firestore composition in `apps/agent/src/deps.ts`. **Production still runs on PostgreSQL.** This inventory covers the agent only. Web and mobile routes are tracked separately.

Production composition: `assistant.config.ts` composes 11 modules, and `infra/gcp/deploy.sh` defaults `ASSISTANT_MODULES=all`. The agent runs with `QUEUE_DRIVER=cloudtasks`, one Cloud Scheduler `/internal/sweep` job per minute, Gmail sync/watch scheduler jobs, and optional canary jobs. `packages/db/src/seed.ts` seeds 19 proactive schedules.

## Classification

- **Ready**: a Firestore adapter is selected in the Firestore composition, and an emulator test exercises it with a throwing SQL proxy.
- **Disabled**: `validateAgentPersistenceConfig` refuses the setting, or the Firestore composition deliberately does not register or run the path. It cannot reach SQL. It is also unavailable to the owner.
- **SQL**: the code path still calls PostgreSQL. It would hit the `unavailableSqlDb()` tripwire if Firestore mode reached it.

Today `validateAgentPersistenceConfig` restricts Firestore agent mode to `ASSISTANT_MODULES` ⊆ `{reminders, calendar}`, `CANARY_ENABLED=false`, and an empty `LOCATION_PING_SECRET`. On `main` it also requires `QUEUE_DRIVER=local`. #383 replaces that with Cloud Tasks support that requires `INTERNAL_AUTH_MODE=oidc`. Anything outside those limits is **Disabled** by configuration, even where parts of it are ported.

## Process and dispatch

| Path | State | Notes |
|---|---|---|
| Boot (`buildFirestoreDeps`), `/health`, `/ready` | Ready | `firestore-boot.test.ts` spawns the process with an unreachable `DATABASE_URL`. No SQL client is constructed. |
| Local poller claim/drain (`QUEUE_DRIVER=local`) | Ready | Fenced by owner readiness. Claims only the configured agent. |
| `/internal/tasks/execute` (Cloud Tasks delivery) | Ready (route) | Runs the same `executeAgentTask`. |
| Durable outbox → Cloud Tasks dispatcher | Ready in #383 | With `QUEUE_DRIVER=cloudtasks`, the scheduled `/internal/sweep` is the single dispatcher. It reclaims expired leases, then runs `dispatchOutbox`. No local poller starts. `/internal/tasks/execute` answers 503 until the installation is ready. Covered by `firestore-cloudtasks.test.ts` and `firestore-boot-cloudtasks.test.ts`. |
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
| Browser/code job staging, callback, and settle | Ready | `executionJobs`. The `/webhooks/{browser,code}/callback` command keeps the hashed sentinel check, callback-versus-timeout ordering, lease fencing, and pending reservation settlement (`firestore-job-callbacks.test.ts`). |
| Final delivery to the task's own chat, generated cards, response checks | Ready | |
| Full composition with all 11 modules (construction + maintenance) | Ready in #387 | `firestore-full-composition.test.ts` checks that `createDb` is never called and every tool is classified. |
| Final delivery for a conversation-less assistant task (e.g. seeded `tomorrow-check`) | Ready | `persistence.notifications`. The `notificationConversations` marker makes concurrent first uses converge on one conversation. `firestore-goals-missions.test.ts` races two finals and four direct calls. |
| Goal-blocked write (`recordGoalBlocked`) | Ready | `persistence.goals.recordBlocked`. `firestore-goals-missions.test.ts` runs an unattended goal session to its clarify park. |
| Missions (`startMission`, `wakeMission`) | Ready | `enqueueTask` carries the reflection cadence; the wake reads sessions and spend through `persistence.missions`, and reports through `persistence.messages` and the goal mirror. `firestore-goals-missions.test.ts` covers start, session spawn, the in-flight guard, the budget stop, and reflection. |
| Save-status answers | Ready | |

## Code jobs (`packages/core/src/memory/jobs.ts`)

| Job | Seeded schedule | State |
|---|---|---|
| `reminder.notify` | per reminder | Ready (#368, `firestore-reminder-delivery.test.ts`) |
| `memory.consolidate` | memory-consolidation | Ready (`firestore-memory-consolidation.test.ts`) |
| `memory.graph_sync` | knowledge-graph-sync | Ready (`firestore-graph-sync.test.ts`) |
| `documents.extract` | per upload | Ready (`firestore-document-extraction.test.ts`). The upload path is in PR #360. |
| `watch.suggest` | per watch fire | Ready. It uses only `persistence.watches/messages/executionContext`. |
| `memory.extract` (+ commitments) | memory-extraction | Ready (`firestore-memory-extraction.test.ts`). Each conversation's facts, occasions, and open loops commit with a per-task checkpoint under the task lease, so a reclaimed run resumes after the last committed conversation. |
| `memory.sweep_loops` | open-loop-sweep | SQL |
| `email.extract` | email-extraction | SQL |
| `briefing.compose` | daily-briefing | Ready (`firestore-briefing.test.ts`). Reads the same inputs through `persistence.briefing`, proposes dates through `persistence.suggestions` (one per source, UUID-shaped ids), and posts through `persistence.ownerNotices`. |
| `pulse.check` | pulse (every 20 min) | Ready (`firestore-pulse.test.ts`). The moment ledger, calendar snapshot, actionable mail, due loops and situation packs go through `persistence.pulse`; suggestions and notices share the briefing seams. |
| `graph.curiosity` | knowledge-graph-curiosity | SQL |
| `memory.graph_date_backfill` | knowledge-graph-date-backfill | SQL |
| `chat.segment` | chat-segmentation | Ready (`firestore-chat-segmentation.test.ts`). Groups only vectors in `FIRESTORE_EMBEDDING_SPACE` and stamps new segments with it; one segment per start message. |
| `anomaly.scan` | anomaly-scan | SQL |
| `skill.reflect` | skill-reflection | SQL |
| `self.improve` | self-improve | SQL |
| `ambient.refresh` | ambient-refresh (every 30 min) | SQL |
| `dream.run` | dream | SQL |
| `self.maintain` | self-maintain | SQL |
| `health.monitor` | assistant-health-monitor | SQL |
| `documents.process` | document-processing (every 15 min) | SQL |
| `import.run`, `voice.ingest` | on demand | Ready (`firestore-imports.test.ts`). Window commits and the voice checkpoint are lease-fenced. |

Imported installations carry these schedules. The SQL jobs are **Disabled** (`firestoreCodeJobUnavailable`): the sweep advances their schedules without creating tasks, and an already-queued SQL job completes benignly. Goal sessions run through the portable goal gate. Unlike PostgreSQL, the Firestore sweep does not re-sync goal cadences each tick; the firing's instruction is rebuilt from the goal's current progress, and the cadence is the one the goal's last mobile or tool mutation wrote.

## Maintenance sweep (`/internal/sweep` and local poller)

| Step | State |
|---|---|
| `expireStaleApprovals`, `resumeResolvedApprovalTasks`, `renotifyStalledApprovals` | Ready |
| Watch expiry (`persistence.watches.expire`) | Ready |
| `runDueSchedules` (portable runner) | Ready. Goal sessions pass `prepareGoalSession` on `persistence.goals`, the same gate PostgreSQL uses (`firestore-goals-missions.test.ts`). |
| Stale cost-reservation release | Ready (`firestore-sweep.test.ts`). Runs inside `purgeExpired`, as in PostgreSQL. |
| `expireStaleSuggestions`, `renotifyStalledAttention`, `emitBudgetNotices` | Ready (`MaintenanceRepository`, `firestore-sweep.test.ts`, `maintenance.test.ts`). Stalled-attention scans walk a durable cursor, so tasks whose notice fails cannot starve later ones. A budget notice and its dedupe key commit together. |
| `backfillMessageEmbeddings` | Ready. Vectors are written only in `FIRESTORE_EMBEDDING_SPACE`, with matching space metadata, and only while the embed role produces that space. Messages are read in creation order behind a durable cursor that advances after the vectors are stored. A vector from another space is re-embedded. |
| `purgeExpired`, `purgeAgedHistory` | Ready. They delete the same data classes as PostgreSQL, including its foreign-key effects: graph provenance for expired memories, recall feedback and card or commitment provenance for messages, captured prompts for model calls, and freed idempotency keys. They keep the same rows: segment anchors, and tool calls referenced by an approval or a retained cost event. Kept rows stay behind a durable cursor that rescans at most daily. `firestore-maintenance-parity.test.ts` runs both drivers on the same rows. |
| `findDueTasks` backstop | Not needed. Every Firestore transition that makes a task runnable commits a durable wake intent. The local drain claims due tasks, and in Cloud Tasks mode the sweep reclaims expired leases and dispatches the outbox. |
| Module sweep steps: watches `reapExpiredWatches`, `pollWebWatches` | Ready in #374. Steps marked `portable` run under Firestore. |
| Module sweep step: google `reapExpiredApplicationWatches` | SQL |
| Module poller ticks: google `email-sync` | SQL. Skipped under Firestore by #374, which runs only ticks marked `portable`. |

## Modules

| Module | Boot | Tools | Hooks / background | State |
|---|---|---|---|---|
| reminders | Ready | `reminder.create/list/cancel` Ready | Delivery Ready (#368) | **Ready** (allowed) |
| calendar | Ready | `calendar.*` reads (HTTP only) Ready | none | **Ready** (allowed) |
| watches | Ready | `watch.create/list/cancel/web` Ready | Sweep steps and web polling portable; email watches fire once google's sync runs | **Ready** (allowed) |
| search | Ready | `web.search` Ready in #381 (`CostRepository.record`) | none | **Ready** (allowed) |
| maps | Ready | `maps.directions` Ready in #381 (`ownerContext.getLatestLocation`) | none | **Ready** (allowed) |
| browser | Ready | `browser.plan/execute` staging Ready | `/webhooks/browser/callback` through the execution-jobs callback command (#400) | **Ready** (allowed) |
| code | Ready | `code.execute` staging Ready | `/webhooks/code/callback` through the execution-jobs callback command (#400) | **Ready** (allowed) |
| watches | Ready | `watch.create/list/cancel/web` Ready | email observers need google; sweep steps portable but not run | Disabled (config) |
| search | Ready | `web.search` Ready in #381 (`CostRepository.record`) | none | Disabled (config); every row Ready |
| maps | Ready | `maps.directions` Ready in #381 (`ownerContext.getLatestLocation`) | none | Disabled (config); every row Ready |
| browser | Ready | `browser.plan/execute` staging Ready | `/webhooks/browser/callback` Ready (`executionJobs.recordCallback`) | Disabled (config); every row Ready |
| code | Ready | `code.execute` staging Ready | `/webhooks/code/callback` Ready (`executionJobs.recordCallback`) | Disabled (config); every row Ready |
| documents | Ready | `documents.search` SQL (pgvector chunks) | `/webhooks/document/callback`, `documents.process` SQL; `documents.extract` Ready | Disabled (config) |
| push | Ready | none | Owner notifier through `persistence.deviceTokens` (list, invalidate on APNs 410), behind the Firestore nudge policy (`firestore-push-notifier.test.ts`) | **Ready** (allowed) |
| sms | Ready | `sms.send` voice rewrite (`loadVoiceContext(db)`) SQL | inbound `/webhooks/twilio/sms`, approval codes, final delivery, notifier: SQL | Disabled (config) |
| google | Ready | Gmail/Docs/Sheets/Slides/Calendar HTTP tools; `gmail.send` voice rewrite SQL; `drive.ingest` SQL; `applications.*` SQL | Gmail Pub/Sub + sync + watch renewal (distributed lock on a reserved PG connection), email channel delivery, application confirmations: SQL | Disabled (config) |

Owner notifications in Firestore mode post to the dashboard (`firestoreDashboardOwnerNotifier`) and fan out to the module phone legs through `persistence.nudgePolicy` (quiet hours and the ambient daily cap), exactly as PostgreSQL does. Each module leg is isolated, so a failing channel never silences the next. `owner.notify` pings through the same gate. The SMS leg itself is still SQL, which is why `sms` stays out of `FIRESTORE_PORTABLE_MODULES`.

## Built-in tools

The Firestore composition registers `memory.save`, `memory.recall`, `task.schedule`, `goals.list`, `goals.create`, `goals.update_progress`, `mission.update`, `owner.notify`, `weather.lookup`, `sports.scores`, `web.fetch`, `workspace.read/write/list`, the record tools below, and (opt-in, non-production) MCP tools.

| Tool | State |
|---|---|
| `weather.lookup` | Ready and registered under Firestore in #381 |
| `sports.scores` | Ready and registered under Firestore in #381 |
| `web.fetch` | Ready and registered under Firestore in #362 |
| `workspace.read/write/list` | Ready and registered under Firestore in #362 |
| `memory.graph_snapshot` | Ready: graph recall repository's verified seeds, filtered by embedding space |
| `tools.read_result` | Ready: tool-execution `load`, scoped to the calling task and owner |
| `occasions.save/list` | Ready: Profile occasion writer with tool provenance (untrusted saves stay quarantined); bounded owner scan for the list |
| `contacts.lookup` | Ready: bounded contact scan, name and alias prefix match |
| `conversations.search` | Ready: owned-conversation vector search in the configured space; bounded newest-first substring fallback |
| `goals.list`, `goals.create`, `mission.update` | Ready (`firestore-goals-missions.test.ts`). `goals.create` also writes the work chat and automation that the PostgreSQL sweep's goal sync would create. |
| `situations.read/decisions/sources/change` | Ready: the situation pack read and command repositories the owner UI uses |

## Remaining work, in dependency order

1. The remaining SQL-only code jobs: `memory.graph_date_backfill`, `graph.curiosity`, `anomaly.scan`, `skill.reflect`, `self.improve`, `dream.run`, `self.maintain`.
2. The google module's Gmail sync, email delivery, application confirmations, `drive.ingest` and `email.extract` (open PRs), then `google` in `FIRESTORE_PORTABLE_MODULES`.
3. Canaries (`CANARY_ENABLED` must stay false) and agent-side location pings (`LOCATION_PING_SECRET` must stay empty).

`validateAgentPersistenceConfig` admits the modules in `FIRESTORE_PORTABLE_MODULES` (reminders, calendar, browser, code, search, maps, watches, push). Add a module there only once every row for it above is Ready.
