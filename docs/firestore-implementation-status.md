# Firestore migration implementation status

Updated 2026-09-08. This is the first implementation batch of the [migration and consumer-install plan](firestore-consumer-install-plan.md). **The complete migration and single-click installer are not finished.** The current application and deployments continue to require PostgreSQL and the existing model/authentication configuration. No live cloud resources or production data were changed.

## Implemented

- `packages/persistence`: SDK-independent shapes for all 63 current tables, money/embedding value types, and command contracts. A compile-time compatibility test checks both table coverage and every PostgreSQL record shape. This is type coverage, not full Firestore repository coverage.
- `packages/db`: PostgreSQL command adapters extracted from core for budgets, message append, task claims/renewal/checkpoints, reminder cancellation, and approval decisions. Existing core entry points delegate through these seams while retaining PostgreSQL defaults. Message append and conversation activity now commit atomically. Stable budget operation IDs support transport retries.
- The regression suite exposed a PostgreSQL millisecond timestamp collision on immediate lease reclaim. Migration `0069_task_lease_fencing.sql` adds an opaque UUID fence, with compatibility for existing null-token leases. Apply this additive migration before starting the updated runtime. Shared adapter tests deliberately force equal timestamps to verify fencing independently of the clock.
- `packages/firestore`: transactional counterparts for those commands, with opaque task fences, integer budget counters, guarded reminder delivery, approval/wake atomicity, and a durable outbox. No external action runs inside a retryable transaction callback.
- A bounded vector feasibility implementation, with embedding-space isolation, provenance, trust/expiry filtering, and erasure tombstones. It has not replaced the existing memory/GraphRAG runtime.
- A shared PostgreSQL/Firestore behavioral suite and Firestore-specific contention, cancellation/delivery, vector, approval, and dispatch-recovery tests.
- `pnpm test:firestore`, a dedicated emulator-only CI job, initial index definitions, deny-all client rules, Docker dependency manifests, and an enumerated database-import migration baseline. New business files cannot add database SDK imports outside that baseline.

## Remaining delivery gates

| Plan phase | Current state | Next required result |
|---|---|---|
| P0 | Partial | Real Firestore/index/IAM/cost checks; actual Cloud Shell authorization flow; Google-model and passkey feasibility |
| P1 | Partial | Complete command contracts and remove remaining SDK imports from business logic; select adapters at composition roots |
| P2 | Partial | Complete task state machine, enqueue/schedule commands, chat reads/cursors, approval sweeps, external-delivery fences, and outbox consumer integration |
| P3 | Pending | All remaining domain/module queries, graph/recall, imports, erasure/export, and operational parity across all 63 table families |
| P4–P6 | Pending | Google models and metering, embedding migration, bounded scheduling, passkeys/recovery and per-device pairing |
| P7–P8 | Pending | Customer-owned Terraform/build pipeline, resumable install manifest/bootstrap, owner onboarding, optional Workspace wizard |
| P9–P11 | Pending | Consistent export/import and migration rehearsal; update/restore/uninstall; fresh-account pilot and release checks |

Do not advertise an install button or enable `DATABASE_DRIVER=firestore` until the relevant runtime and installation gates pass. The Firestore package intentionally does not pretend to implement arbitrary Drizzle queries or a complete application database.

## Validation

Final local checks: 225 test files / 2,040 tests passed in the combined PostgreSQL and emulator suite; the dedicated emulator suite passed 30 tests. Typecheck, production build, lint/architecture checks, dependency audit, and whitespace checks passed. Lint retains nine pre-existing warnings and one configuration-version notice. The build retains the existing unpdf bundler warning. CI was updated but has not been run remotely. The emulator tests prove local transaction behavior, not production IAM/index readiness or cost. No live models, native-device UI checks, cloud installation, or production migration were exercised.

```sh
pnpm lint
pnpm typecheck
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm test:firestore
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 TEST_DATABASE_URL=postgres://assistant@127.0.0.1:55432/assistant_test pnpm test
AUTH_DEV_BYPASS=false AUTH_LOCALHOST_BYPASS=false pnpm exec turbo build --env-mode=loose --force
git diff --check
```

The custom test-database URL is a local verification detail, not a new application default. Docker's local database was unresponsive, so verification used a separate PostgreSQL 17 cluster on loopback port 55432. Java 21, PostgreSQL 17, and pgvector were installed locally for these checks. The existing application database and environment files were preserved. The build explicitly passes safe authentication flags through Turbo because this checkout's web `.env.local` enables development authentication.
