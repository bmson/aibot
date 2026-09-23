# PostgreSQL source write fence

This procedure is a **go/no-go checklist**, not an automated provider fence. The repository now has an opt-in process-level Drizzle write gate, but it is not enabled in any live service and does not revoke PostgreSQL privileges or terminate existing sessions. Do not treat this gate, paused queues, a read-only export transaction, a Cloud Run traffic change, or a quiet `pg_stat_activity` sample as proof that the source is fenced.

## Application maintenance gate

`POSTGRES_SOURCE_WRITES_FENCED=true` opts the web and agent PostgreSQL composition roots into a fail-closed Drizzle guard. It blocks `insert`, `update`, and `delete` builders, blocks raw `execute`/`batch`, and hides the raw postgres.js client. Typed Drizzle reads continue to work. Invalid values fail configuration parsing. The default is `false`, so deploying the code alone does not change runtime behavior.

Web actions and mobile handlers that use the web application database, plus agent webhooks, internal callbacks, Cloud Tasks execution, local scheduling, and agent maintenance steps, share these guarded connections. For a rehearsal, set the flag only on isolated test services/jobs and confirm a representative mutation is rejected while a typed read succeeds.

This is a per-process guard, not an authoritative database fence. It does not affect an already-running old revision until that process is stopped, and it cannot account for an in-flight write that was already issued. Scripts that construct `postgres()` directly (including the standalone schema repair utility), external clients, operators, and any unreviewed process that does not use `createDb()` bypass it. The workspace exporter has its own read-only transaction, which is unrelated to this application setting. Keep the provider-side fence below as a required cutover gate.

The production database URL is held in Secret Manager as `database-url` and is injected into both `assistant-web` and `assistant-agent`. The migration and workspace-export Cloud Run Jobs also receive that URL. The export job makes its own transaction read-only, but that limits only that export transaction. The agent accepts direct webhooks and internal work, and Cloud Tasks, Cloud Scheduler, and the Gmail Pub/Sub push subscription can all deliver more work. Local operator scripts and any other database clients are outside those Cloud Run controls.

The live PostgreSQL provider has been identified as Neon from read-only secret URL classification. Neon distinguishes the primary read-write compute from read-only replica computes ([Neon endpoint documentation](https://neon.com/docs/manage/endpoints/)); selecting a read-only endpoint for export does not by itself fence writes to the primary. A read-only role preflight found that the application role is not a superuser but has `CREATEROLE`, `pg_signal_backend`, and `pg_monitor` membership, and owns all 67 user tables. In particular, ordinary table grants revoked from that same owner role would not provide a credible fence. Those attributes do not prove a reversible provider fence, coverage of all sessions, or an authorized exporter identity; the provider procedure must be tested with a separate exporter/admin identity and session control. The Neon pooled endpoint rejected a `PGOPTIONS` startup read-only request, while an explicit `BEGIN READ ONLY` transaction succeeded; that result only establishes the scope of that transaction. The exact Neon provider-side write fence, privileged session-drain proof, and consistent read-only export path still require a separately verified procedure before cutover. This application gate is not sufficient to mark that requirement complete, and this change does not access or modify the live endpoint.

## Required database-provider capability

Before scheduling the final export, the database owner must identify the provider and database role used by `database-url`, then demonstrate a provider-side fence with all of these properties:

1. It rejects all writes by every source application principal, including already-open sessions and reconnects.
2. It still permits the final exporter to read a consistent snapshot, using a separately authorized read-only identity or an explicitly supported provider read-only mode.
3. A privileged provider view can show no active source write transactions and can identify remaining sessions. The view must cover sessions owned by other roles; ordinary `pg_stat_activity` access often does not.
4. The fence can be removed without restoring or changing source data.

Do not use `default_transaction_read_only` as the fence: a client can override that session setting, and it does not change already-open transactions. Do not assume that the application role can alter role/table grants, signal other sessions, or inspect all sessions. The repository does not establish those privileges. If the provider cannot supply the four properties above, stop here and retain PostgreSQL as authoritative.

## Capture the writer inventory

Run these read-only commands immediately before the maintenance window. Save their output with the final export manifest; resource names and service URLs are not secret values.

```sh
gcloud run services list --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='table(metadata.name,status.url,status.latestReadyRevisionName)'
gcloud run jobs list --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='table(metadata.name,status.latestCreatedExecution.name)'
gcloud scheduler jobs list --project "$GCP_PROJECT" --location "$GCP_REGION" \
  --format='table(name,state,schedule,httpTarget.uri)'
gcloud tasks queues list --project "$GCP_PROJECT" --location "$GCP_REGION" \
  --format='table(name,state)'
gcloud pubsub subscriptions list --project "$GCP_PROJECT" \
  --format='table(name,topic,pushConfig.pushEndpoint)'
```

Also inspect enabled module schedules in the release's module plan and inventory any other Cloud Run regions, manually launched jobs, local scripts, external database clients, and integration callbacks. The deploy script creates `assistant-sweep`, module-declared Scheduler jobs, `assistant-canaries` jobs when enabled, the configured Cloud Tasks queue (default `agent-steps`), and (when the Google module is enabled) the `gmail-events-push` subscription; the live inventory is authoritative because deployment configuration can drift.

For every Cloud Run service and job, record whether its current template references the `database-url` secret without printing secret contents:

```sh
gcloud run services describe SERVICE --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='yaml(metadata.name,spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].valueFrom.secretKeyRef)'
gcloud run jobs describe JOB --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --format='yaml(metadata.name,spec.template.template.spec.containers[0].env[].name,spec.template.template.spec.containers[0].env[].valueFrom.secretKeyRef)'
```

Do not paste any rendered environment values or secret payloads into the evidence report.

## Fence and prove drain

1. Announce the maintenance window and stop new owner activity. Pause every Cloud Scheduler job from the captured inventory. Pause each Cloud Tasks queue and record its state and pending-task count. Stop or detach each push subscription in a reversible way, preserving its backlog. Stop public application writes through a reviewed maintenance release or provider-side database fence; there is no existing repository switch for this.
2. Stop all remaining direct writers, including operator scripts and external callbacks. Keep a list of the stopped identities and the time each was stopped.
3. Apply the database-provider fence described above. Record the provider operation/audit identifier and its exact scope. Verify a write attempt through a disposable transaction is rejected while a read-only connection can still read the source. Roll back the disposable transaction; never test by modifying production data.
4. Drain or cancel active work according to its durable source state. Confirm no queued request can later execute against PostgreSQL. Preserve queue/subscription backlog for rollback, or explicitly account for each item before discarding it.
5. Use the provider's privileged session/transaction view to verify there are no active write transactions and no unfenced application principal. Capture the query, timestamp, database identity, principal inventory, and result. Repeat after the longest request/job timeout and after queued callbacks have stopped retrying. A single quiet sample is insufficient.
6. Only after the provider fence and drain evidence pass, run the pinned workspace export. Record the export SHA-256, object generation, source snapshot timestamp, and migration release SHA. Keep the fence in place through import, parity review, target backup/restore, and the explicit production activation decision.

The freeze is reversible only after rollback or cutover ownership is explicit. For rollback, restore the database-provider write capability first, then restore Cloud Run service traffic and resume the exact Scheduler jobs, queues, and subscriptions recorded in the inventory. Verify each resource's prior state. Do not resume both PostgreSQL writers and Firestore dispatchers at the same time.

## Evidence required to mark the gate complete

- Provider, database, source principals, fence scope, reversible operation, and provider audit ID.
- Before/after resource inventories and captured prior state for every service, job, queue, scheduler, and subscription.
- Evidence that all app writes fail while the source remains readable to the exporter.
- Provider-level session and active-transaction evidence after the drain interval.
- Queue and subscription backlog disposition, including retries that could arrive after the export.
- Pinned final export URI, generation, SHA-256, source timestamp, and exact exporter image commit.

If any item is unavailable, label the export a rehearsal and leave the source database in service. Never infer the write fence from a successful export alone.
