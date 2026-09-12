# Firestore migration implementation status

Updated 2026-09-12. This tracks the implementation batches of the [migration and consumer-install plan](firestore-consumer-install-plan.md). **The complete migration and single-click installer are not finished.** The current application and deployments continue to require PostgreSQL and the existing model/authentication configuration. Production release of the adapter foundation applies the additive PostgreSQL lease-token migration; it does not move production data into Firestore.

## Implemented

- `packages/persistence`: SDK-independent shapes for all 63 current tables, money/embedding value types, and command contracts. A compile-time compatibility test checks both table coverage and every PostgreSQL record shape. This is type coverage, not full Firestore repository coverage.
- `packages/db`: PostgreSQL command adapters extracted from core for budgets, message append, task claims/renewal/checkpoints, reminder cancellation, and approval decisions. Existing core entry points delegate through these seams while retaining PostgreSQL defaults. Message append and conversation activity now commit atomically. Stable budget operation IDs support transport retries.
- The regression suite exposed a PostgreSQL millisecond timestamp collision on immediate lease reclaim. Migration `0069_task_lease_fencing.sql` adds an opaque UUID fence, with compatibility for existing null-token leases. Apply this additive migration before starting the updated runtime. Shared adapter tests deliberately force equal timestamps to verify fencing independently of the clock.
- `packages/firestore`: transactional counterparts for those commands, with opaque task fences, integer budget counters, guarded reminder delivery, approval/wake atomicity, and a durable outbox. No external action runs inside a retryable transaction callback.
- A bounded vector feasibility implementation, with embedding-space isolation, provenance, trust/expiry filtering, and erasure tombstones. It has not replaced the existing memory/GraphRAG runtime.
- A shared PostgreSQL/Firestore behavioral suite and Firestore-specific contention, cancellation/delivery, vector, approval, and dispatch-recovery tests.
- `pnpm test:firestore`, a dedicated emulator-only CI job, initial index definitions, deny-all client rules, Docker dependency manifests, and an enumerated database-import migration baseline. New business files cannot add database SDK imports outside that baseline.

## Task lifecycle follow-up

The second implementation batch moves sleep, budget/approval/event parking, completion/cancellation, attention notices, bounded failure retries, manual wake-up, and expired-lease recovery behind `TaskRepository`. Core wrappers retain their existing API and PostgreSQL runtime. Firestore commits newly runnable generations with their outbox intent and rejects stale executor leases on every transition. PostgreSQL recovery now rechecks expiry when updating a task, so a renewal after the initial expired-task query is not overwritten.

The cross-adapter lifecycle tests cover checkpoint preservation, retry caps, owner-scoped budget increases, terminal cancellation, and concurrent expired-lease recovery. This follow-up has not changed the deployed database driver.

## Task creation and dispatch follow-up

Task creation now uses the shared repository too. PostgreSQL serializes the external-task count and insertion; Firestore serializes it on an installation coordination record and commits the task, event uniqueness record, and first outbox intent together. Duplicate events return their existing task before checking the rate cap, and an event collision cannot return another agent's task. Owner work and internal children keep their existing exemption. Firestore requires an explicit `rateLimits/task` policy at bootstrap, with null values for intentionally unlimited caps.

The durable dispatcher awaits Cloud Tasks acceptance before acknowledging an outbox lease. Failed or ambiguous dispatches remain retryable with the same provider task name. Batch size, concurrency, and dispatch time are bounded. New queue deliveries include a generation checked atomically at claim time by both repositories, the general executor, and the current deterministic module handlers. Legacy deliveries without a generation remain accepted during the transition.

The Firestore outbox and Cloud Tasks transport are integrated and exercised together in an emulator test. **The scheduled Firestore dispatcher and application composition are not enabled in production**: the rest of the executor and application still require PostgreSQL. No additional SQL migration is required for this batch.

`pnpm firestore:validate --project PROJECT` previews an isolated real-cloud validation run; `--run` creates a fresh `assistant-validation-*` database, waits for task/outbox/schedule indexes, executes synthetic task/schedule/concurrency/recovery checks, records Query Explain metrics, and deletes that database in cleanup. It never adopts `(default)` or a caller-supplied database. This is validation tooling, not the consumer installer. Google Cloud login/ADC must be available before a live run. The run does not prove production runtime-service-account IAM, live Cloud Tasks OIDC delivery, full-workload pricing, or the remaining Firestore domains.

## Schedule firing follow-up

Schedule creation, bounded due queries, initialization, and occurrence commits now share a PostgreSQL/Firestore repository. Creating a task and advancing or disabling its schedule are atomic; Firestore includes the event uniqueness record and outbox intent in that transaction. Both adapters recheck the complete schedule snapshot and cancellation state, so stale sweeps cannot fire edited or cancelled reminders. PostgreSQL uses the same advisory lock as reminder cancellation and delivery.

The current PostgreSQL scheduler, early morning brief, and reminder creation tools use this seam. One-time reminders retain their exact first firing time and remain deliverable after their schedule is disabled. Firestore delivery binds the occurrence ID to the persisted task event and payload before committing the in-app message. Shared adapter tests cover concurrent creation/firing, cancellation races, stale edits, initialization, transaction rollback, owner isolation, and early-versus-due races. The portable runner also has a synthetic Firestore smoke test shared between emulator CI and isolated cloud validation.

This does not yet port the reminder list/cancel lookup tools, goal synchronization/policy queries, or complete executor composition. A goal schedule without a goal preparation adapter explicitly rejects the portable sweep rather than authorizing unchecked work. Firestore runtime activation remains gated on those domains. Future imports must preserve schedule IDs, backfill task `scheduleId` and `occurrenceId` from validated event provenance, and reject ambiguous legacy schedule names. `ensure` can adopt a unique legacy schedule and creates a transactional `scheduleNames` uniqueness record scoped to its agent. The new schedule index orders by `enabled`, `nextRunAt`, and `id`. There is no additional SQL migration for this batch.

## Remaining delivery gates

| Plan phase | Current state | Next required result |
|---|---|---|
| P0 | Partial | Runtime-service-account IAM, live queue delivery and representative cost checks; remaining domain indexes; actual Cloud Shell authorization flow; Google-model and passkey feasibility |
| P1 | Partial | Complete command contracts and remove remaining SDK imports from business logic; select adapters at composition roots |
| P2 | Partial | Chat reads/cursors, approval sweeps, external-delivery fences, reminder management reads, and Firestore application/dispatcher composition |
| P3 | Pending | All remaining domain/module queries, graph/recall, imports, erasure/export, and operational parity across all 63 table families |
| P4–P6 | Pending | Google models and metering, embedding migration, bounded scheduling, passkeys/recovery and per-device pairing |
| P7–P8 | Pending | Customer-owned Terraform/build pipeline, resumable install manifest/bootstrap, owner onboarding, optional Workspace wizard |
| P9–P11 | Pending | Consistent export/import and migration rehearsal; update/restore/uninstall; fresh-account pilot and release checks |

Do not advertise an install button or enable `DATABASE_DRIVER=firestore` until the relevant runtime and installation gates pass. The Firestore package intentionally does not pretend to implement arbitrary Drizzle queries or a complete application database.

## Validation

Foundation checks: 225 test files / 2,040 tests passed in the combined PostgreSQL and emulator suite; the dedicated emulator suite passed 30 tests. Typecheck, production build, lint/architecture checks, dependency audit, and whitespace checks passed. PR #125 and main CI passed all four jobs, including the dedicated Firestore emulator job; the manually dispatched iOS build/test workflow passed. Lint retains nine pre-existing warnings and one configuration-version notice. The build retains the existing unpdf bundler warning. The emulator tests prove local transaction behavior, not production IAM/index readiness or cost. No live model calls, native-device UI checks, or customer cloud installation were exercised.

Task-lifecycle follow-up: all 227 test files / 2,050 tests passed with PostgreSQL and the Firestore emulator, including deterministic renewal-versus-recovery races against both adapters. Typecheck, lint/architecture checks, production build, and whitespace checks passed. This batch was built in an isolated worktree without a web `.env.local`; it has no additional SQL schema migration.

Task-creation/dispatch follow-up: all 231 test files / 2,073 tests passed with PostgreSQL and the Firestore emulator; the dedicated emulator command passed 46 tests, including dispatch transport composition and the same synthetic task checks used by the live validation harness. Typecheck, lint/architecture checks, production build, dependency audit, and whitespace checks passed. The validation preview ran successfully; real Firestore validation remains unexecuted because local Google Cloud authentication needs refreshing and Application Default Credentials are absent.

Real-cloud follow-up (2026-09-10): refreshed credentials cleared that blocker, and the Firestore API was enabled in `bmson-assistant`. The first live workload exposed a missing `(runAfter, status, updatedAt)` index for the due-query's null wake-time branch; the failed run's temporary database was deleted. After adding that index alongside the scheduled-work index, the synthetic workload and Query Explain passed on a fresh Standard/Native Firestore database. This covers task creation, event deduplication, rate-limit contention, generation fencing, sleep/wake recovery, cancellation, and outbox transactions under the supplied administrative credentials. It does not prove runtime-service-account permissions, real Cloud Tasks transport/OIDC, production-workload costs, or other database domains. Production remains on PostgreSQL.

The harness now builds indexes concurrently, waits for every operation before cleanup even on failure, and reports validation outcomes before waiting for database deletion. All 231 test files / 2,075 tests passed locally, including six resource-lifecycle tests. Typecheck, lint/architecture checks, production build, and whitespace checks passed.

Schedule follow-up (2026-09-12): the PostgreSQL/emulator suite passed, including the shared scheduling contract and composed reminder smoke test. Lint/architecture checks, typecheck, production build, and whitespace checks passed. Live validation stopped before database creation because Google required a fresh reauthentication (`invalid_rapt`); the new schedule indexes and workload remain unverified on real Firestore until that rerun succeeds. Earlier real-cloud task validation above remains a separate result.

```sh
pnpm lint
pnpm typecheck
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm test:firestore
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 TEST_DATABASE_URL=postgres://assistant@127.0.0.1:55432/assistant_test pnpm test
AUTH_DEV_BYPASS=false AUTH_LOCALHOST_BYPASS=false pnpm exec turbo build --env-mode=loose --force
git diff --check
```

The custom test-database URL is a local verification detail, not a new application default. Docker's local database was unresponsive, so verification used a separate PostgreSQL 17 cluster on loopback port 55432. Java 21, PostgreSQL 17, and pgvector were installed locally for these checks. The existing application database and environment files were preserved. The build explicitly passes safe authentication flags through Turbo because this checkout's web `.env.local` enables development authentication.
