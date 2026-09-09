# Firestore persistence migration

Experimental server-side adapters for the [customer-owned installation plan](../../docs/firestore-consumer-install-plan.md). The running application still uses PostgreSQL. This package is not yet a replacement for `createDb()` and there is no deployable Firestore installation profile.

The adapters implement transactional budget reservations/settlement, task claims/renewal/checkpoints, message append, reminder cancellation and in-app delivery, approval decisions, and durable queue intents. Vector save/retrieval/erasure is a feasibility implementation with explicit embedding-space versions. The application still needs its other SQL use cases migrated before selecting Firestore at startup.

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
- Both adapters now issue an opaque task-lease token; SQL migration `0069_task_lease_fencing.sql` adds the nullable column for existing installations. Apply it before starting the new PostgreSQL runtime. Existing null-token leases remain readable during the transition. A replaced or cancelled lease cannot checkpoint or renew. Claim timing currently uses the service clock; real-infrastructure skew/contention validation is still required. Other executor-owned mutations have not yet moved to this adapter.
- Reminder delivery and cancellation serialize on the schedule document. `deliver()` commits an in-app message and a receipt under the live task lease. It does not send external notifications. Enqueued Firestore reminder tasks must carry `trigger.payload.scheduleId`. Cancellation cleans at most 200 queued tasks immediately and its authoritative schedule fence blocks later delivery from the remainder; a bounded cleanup worker is still required.
- Channel-message IDs use separate uniqueness records. Append and conversation activity commit together. Messages above the conservative 900 KB inline limit fail explicitly; the Cloud Storage overflow path remains to be implemented. Arbitrary JSON/nested-array compatibility still needs full DTO coverage before deployment.
- Approval resolution commits its tool status, optional policy, guarded task wake, and outbox intent together. The existing pending-status semantics remain; expiry/renotification sweeps still need Firestore adapters. Short-code ambiguity is rejected in the Firestore adapter. PostgreSQL retains its existing resolver semantics.
- Queue intents persist until dispatched. Call `createWakeIntent()` in the same transaction as a state transition. `FirestoreOutbox` leases/acknowledges/retries dispatch, but the Cloud Tasks consumer is not yet wired. Use the intent ID for the provider task name; duplicate delivery still requires the executor's generation and lease checks. This is not an exactly-once guarantee for external side effects.
- Memory vectors are separated by provider, model, revision, and dimensions. Retrieval rechecks authoritative records/tombstones after the vector query and excludes quarantined, expired, superseded, and other-agent memories. Candidate retrieval is bounded and can underfill after filtering. Graph traversal, lexical ranking, conversation recall, six vector-table coverage, extraction, privacy export, and the rest of memory parity remain SQL-backed.

The [index specification](../../infra/gcp/firestore/firestore.indexes.json) covers the implemented queries, with a **1536-dimensional example** vector index. The eventual installer must derive the dimension from its model manifest and await index readiness. Emulator success does not validate production indexes, IAM, latency, billing, or quota behavior. The deny-all client [rules](../../infra/gcp/firestore/firestore.rules) preserve server-only access; server SDK authorization uses IAM.

See the [implementation status](../../docs/firestore-implementation-status.md) for completed work and the remaining installation gates.
