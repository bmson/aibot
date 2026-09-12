# Workspace migration rehearsal

This tooling exports a consistent PostgreSQL snapshot and imports a supported subset into a new Firestore installation. It is not a full backup or a production cutover. The live application still uses PostgreSQL.

Supported tables are agents, contacts, conversations, channel bindings, messages, tasks, tool calls, approvals, approval policies, schedules, memories, memory tombstones, and goals. The manifest reports incomplete coverage and omitted tables. Installation-wide contacts and tombstones require a source containing exactly one agent. Tables outside the subset are rejected when explicitly requested.

## Export

`pnpm workspace:export` previews without connecting to PostgreSQL. Actual export requires an explicit source URL and owner identity; it never falls back to the configured application database. Use a direct PostgreSQL connection with access to the intended workspace.

```sh
pnpm workspace:export --export --database-url "$MIGRATION_DATABASE_URL" \
  --agent-id SOURCE_AGENT_UUID --project-id CUSTOMER_PROJECT \
  --database-id DATABASE_ID --installation-id INSTALLATION_ID \
  --out workspace-migration.json
```

The exporter uses one read-only repeatable-read snapshot. It preserves IDs, timestamps, decimal strings, bytes, and JSON values in a versioned format with record/table/bundle checksums. Output is created exclusively with mode 0600 and cannot silently overwrite an existing file. The bundle contains private workspace data; protect it as a database export.

## Validate and rehearse

```sh
pnpm workspace:import --in workspace-migration.json
```

Preview checks identities, references, counts, and checksums without writing. A real import requires every target identity explicitly and either a local emulator or `--allow-cloud`:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8789 pnpm workspace:import --write \
  --in workspace-migration.json --agent-id SOURCE_AGENT_UUID \
  --project-id demo-assistant-test --database-id '(default)' \
  --installation-id INSTALLATION_ID
```

The target must match the bundle exactly, so create an export targeting the emulator identities when rehearsing. For authenticated cloud writes, omit the emulator variable and add `--allow-cloud`. This is explicit import authorization, not activation.

The importer refuses a populated installation, writes a migration marker before importing, and commits each record batch together with its progress cursor. A restart verifies checksums of the completed prefix before continuing; conflicting writers or modified records stop the import. It creates no runnable outbox work. Task claims and schedule occurrence commits remain blocked while the marker is pending. Successful import ends at `pending_activation`; there is deliberately no activation command.

Memory-containing imports are currently refused because the source does not record enough embedding-space provenance. For limited rehearsals, select an explicit subset with `--tables` at export; that does not substitute for preserving the excluded memories during real migration. Full domain coverage, model catalog/budget/bootstrap data, legacy task/schedule provenance, embedding migration, and end-to-end validation must be completed before a production cutover. Keep the source workspace available until those checks pass.
