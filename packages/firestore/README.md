# Firestore persistence migration

Experimental server-side adapters for the [customer-owned installation plan](../../docs/firestore-consumer-install-plan.md). The running application still uses PostgreSQL. This package is not yet a replacement for `createDb()` and there is no deployable Firestore installation profile.

The adapters implement transactional budget reservations/settlement, task creation and lifecycle commands, message append, reminder cancellation and in-app delivery, approval decisions, and durable queue intents. Vector save/retrieval/erasure is a feasibility implementation with explicit embedding-space versions. The application still needs its other SQL use cases migrated before selecting Firestore at startup.

## Local validation

Requirements: Node 22+, pnpm, Google Cloud CLI with the `cloud-firestore-emulator` component, and Java 21. The CI job pins Google Cloud CLI 576.0.0. Local validation used emulator 1.21.0 and `@google-cloud/firestore` 9.0.1.

Start the emulator in one terminal:

```sh
gcloud emulators firestore start --host-port=127.0.0.1:8789 --quiet
```

Run its suite in another:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm test:firestore
```

The dedicated command fails when the emulator is missing. Fixtures require a loopback host and use unique installation scopes in `demo-assistant-test`. Cleanup deletes only those scopes. No cloud project, billing account, service-account key, or model credentials are needed.

To also run the PostgreSQL regression suite, start the repository's PostgreSQL test database and run:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm test
```

`pnpm test` retains the existing isolated `_test` database preparation. The shared command contract runs against both implementations. Without `FIRESTORE_EMULATOR_HOST`, ordinary PostgreSQL runs skip the Firestore integration files; CI has a separate mandatory emulator job.

## Storage contracts

- Records live below `installations/<encoded-installation-id>/<collection>/<encoded-record-id>`. Identifier encoding prevents provider IDs containing slashes from changing scope. Every customer should still get a dedicated Google Cloud project; these paths are not an IAM tenant-isolation mechanism.
- Monetary counters use integer microdollars. Budget settlement atomically changes holds, the ledger event, daily/monthly counters, and task spend. A missing Firestore budget policy fails closed. Budget-policy initialization and migration of existing ledger totals remain installation work.
- Firestore daily/monthly accounting uses UTC. PostgreSQL keeps its existing database/server-time behavior during this refactor. Cutover must explicitly reconcile period counters; do not infer them from a partial ledger import.
- Both adapters now issue an opaque task-lease token; SQL migration `0069_task_lease_fencing.sql` adds the nullable column for existing installations. Apply it before starting the new PostgreSQL runtime. Existing null-token leases remain readable during the transition. A replaced or cancelled lease cannot checkpoint or renew. Claim timing currently uses the service clock; real-infrastructure skew/contention validation is still required. The extended `FirestoreTaskRepository` also implements sleep/parking, terminal transitions, retries, attention notifications, wake-up, and bounded lease recovery. Creation now records a durable initial wake intent; deployment of the Firestore dispatcher/executor remains pending.
- Reminder delivery and cancellation serialize on the schedule document. `deliver()` commits an in-app message and a receipt under the live task lease. It does not send external notifications. Enqueued Firestore reminder tasks must carry `trigger.payload.scheduleId`. Cancellation cleans at most 200 queued tasks immediately and its authoritative schedule fence blocks later delivery from the remainder; a bounded cleanup worker is still required.
- Channel-message IDs use separate uniqueness records. Append and conversation activity commit together. Messages above the conservative 900 KB inline limit fail explicitly; the Cloud Storage overflow path remains to be implemented. Arbitrary JSON/nested-array compatibility still needs full DTO coverage before deployment.
- Approval resolution commits its tool status, optional policy, guarded task wake, and outbox intent together. The existing pending-status semantics remain; expiry/renotification sweeps still need Firestore adapters. Short-code ambiguity is rejected in the Firestore adapter. PostgreSQL retains its existing resolver semantics.
- Task creation commits its event uniqueness key and initial outbox intent in the same transaction. External root tasks serialize through an installation coordination document and bounded aggregate counts over the hour/day windows. Seed `rateLimits/task` explicitly (`maxPerHour`/`maxPerDay`, each an integer or null); a missing or malformed policy fails closed. The installation-wide event key must be retained/rebuilt consistently with task history during migration and erasure.
- Queue intents persist until dispatched. Call `createWakeIntent()` in the same transaction as a state transition. Core's `dispatchOutbox()` composes `FirestoreOutbox` with the awaited Cloud Tasks transport. Both legacy notifications and durable dispatch derive the provider name from `queueTaskId(taskId, generation)`; the outbox document ID remains an internal receipt key. New callbacks carry the generation into the atomic claim, while existing generation-less callbacks remain compatible. This is not an exactly-once guarantee for external side effects. Scheduling this dispatcher against a complete Firestore executor is still a deployment gate.
- Memory vectors are separated by provider, model, revision, and dimensions. Retrieval rechecks authoritative records/tombstones after the vector query and excludes quarantined, expired, superseded, and other-agent memories. Candidate retrieval is bounded and can underfill after filtering. Graph traversal, lexical ranking, conversation recall, six vector-table coverage, extraction, privacy export, and the rest of memory parity remain SQL-backed.

The [index specification](../../infra/gcp/firestore/firestore.indexes.json) covers the implemented queries, with a **1536-dimensional example** vector index. The eventual installer must derive the dimension from its model manifest and await index readiness. Emulator success does not validate production indexes, IAM, latency, billing, or quota behavior. The deny-all client [rules](../../infra/gcp/firestore/firestore.rules) preserve server-only access; server SDK authorization uses IAM.

Task recovery reads at most the requested batch (1–200) of expired running tasks ordered by lease expiry, then rechecks each inside its own transaction. The due query returns at most that batch of pending or elapsed sleeping/budget tasks ordered by `updatedAt`. Both queries stay within one installation collection. Document result bounds do not bound index entries scanned: preserving the existing oldest-update ordering can require scanning scheduled tasks whose `runAfter` is still in the future. Measure this with Query Explain before enabling the runtime; see [Google's index ordering guidance](https://firebase.google.com/docs/firestore/query-data/multiple-range-fields). Future wakes are durably recorded in the outbox, so the eventual scheduler should dispatch from its `availableAt` index and use task recovery as bounded repair.

See the [implementation status](../../docs/firestore-implementation-status.md) for completed work and the remaining installation gates.

## Isolated real-cloud task validation

Preview without credentials or cloud writes:

```sh
pnpm firestore:validate --project YOUR_TEST_PROJECT
```

After configuring Application Default Credentials and enabling the Firestore API in that project, add `--run`. The command creates a new named Standard/Native database, provisions the versioned task/outbox indexes, runs the synthetic task smoke flow, records the runtime due-query's Query Explain metrics, and deletes its database afterward. It requires database/index administration in the selected project and uses billable resources. It does not read your current workspace, use `(default)`, or create service-account keys. On an interrupted process or failed cleanup, use the exact database name printed in the progress log to remove the remaining validation resource.

This validates real query/index/transaction behavior under the supplied credentials. Live Cloud Tasks delivery, runtime service-account IAM, representative pricing, vector/recall parity, and the customer installation flow need separate validation; the report marks unexercised checks explicitly.
