# Complete Firestore cutover

The migration is complete only when production can operate with the old PostgreSQL database unavailable and every source record and stored asset is accounted for. Adapter releases and synthetic chat tests are intermediate evidence.

## Acceptance gates

- [ ] Every enabled web, mobile, agent, module, worker, maintenance, and tool path uses Firestore-compatible persistence. No SQL fallback may run in the Firestore composition.
- [ ] Complete source inventory covers all database tables, object storage, secrets, external integration credentials, schedules, active work, and vector embedding provenance. Sensitive values stay out of reports and logs.
- [ ] Complete, consistent export and resumable import preserve records, references, timestamps, bytes, decimal values, privacy markers, and compatible vectors. Oversized records and Firestore-specific derived records are handled explicitly.
- [ ] Source-to-target parity is verified by table counts and canonical record hashes; any intended transformation has an explicit verified mapping. Historical and active data are both covered.
- [ ] A rehearsal starts the complete application against the migrated target with PostgreSQL unavailable and exercises authenticated web/mobile chat, tools, recall, approvals, schedules, background jobs, uploads, and enabled integrations.
- [ ] Customer-owned deployment has runtime IAM, indexes, queues, scheduler, storage, secrets, authentication, owner onboarding, and the guided installer. No publisher-owned paid runtime dependency is required.
- [ ] Firestore backup/export and restore have been tested into an isolated target, including externally stored assets and encryption prerequisites.
- [ ] Final cutover freezes source writes and drains or fences active work, captures the final consistent data set, verifies parity, activates exactly one scheduler/dispatcher, and switches production.
- [ ] Live verification shows the exact release commit, working end-to-end application behavior, and no PostgreSQL connections or database-secret dependency. Rollback instructions and the recovery archive are usable.
- [ ] Old database retirement is ready: the user has a concrete evidence report showing that deleting it will remove no remaining runtime or recovery dependency.

## Active work

Recovery baseline (2026-09-19): application commit `259d4ecaf8624ea3c337647d442b5b90ea2a29a1`. PostgreSQL is still authoritative. The saved migration work has been reconciled with current chat visibility, immediate memory corrections, and generated-card refresh behavior. The complete installer and production data cutover are unfinished.

The September 12 source snapshot passed offline preview, full local Firestore emulator import, and a separate verification pass: 61,382 source records, 14,565 derived documents, 75,947 total writes including the migration marker. Every source table was covered. Legacy approval codes and nested JSON arrays are preserved. This is a rehearsal snapshot; production still needs a fresh final export after writes are fenced.

Application chat, historical/graph recall, memory save/recall, generated cards, and scheduled follow-up tools now have portable adapters. Remaining work includes runtime composition, enabled module/tool and management domains, memory writers, customer deployment/onboarding, object verification, backup/restore, and final cutover. The old database remains intact until the acceptance gates establish that it is safe to remove.

The real Google query/runtime validator passed with 49 indexes and 16 field exemptions, including the exercised chat and recall paths with zero SQL access. An isolated GCS rehearsal backed up and restored all 86 available application assets (60,038,954 bytes), with matching source/backup/restore SHA-256 and byte counts. Seventeen referenced objects were already absent at source; their metadata remains preserved. These results do not establish full production runtime portability or final cutover parity.

A separate real Firestore managed export/import smoke passed inventory and checksum parity for mixed native values, nested local references, and missing-parent descendants. Both temporary databases were deleted. The backup tool now requires PITR and rejects native references to external databases/projects because Google's managed import changes their targets. A complete production-data backup/restore remains required before retirement.

The manual [Cloud Run source snapshot workflow](firestore-production-export.md) can capture a fresh read-only PostgreSQL v3 bundle directly into the installation's private workspace bucket without disclosing the database URL to GitHub Actions. An unfenced snapshot remains a rehearsal until the final source write freeze and parity gates above pass.

The matching [Cloud Run import workflow](firestore-production-import.md) pins a private snapshot by object generation and SHA-256, previews all target writes, imports only into an empty installation, and verifies document checksums and collection counts. These are manual rehearsal capabilities; runtime activation and database retirement still require every acceptance gate above.

The [PostgreSQL source write-fence procedure](firestore-source-write-fence.md) records the current gap: this repository has no write-freeze switch or provider-side session control. A final export remains a rehearsal until a provider-level fence and drained-session evidence are available.

The [September 23 production-data rehearsal](firestore-rehearsal-2026-09-23.md) records a pinned 70,372-record source export, full Firestore import/independent verification, ready indexes and data preflight, a private PostgreSQL-free agent boot, and a managed target backup. It also records the create-only recovery and independent verification of 12 historical asset generations, five references that still require an owner archive or accepted-loss decision, and the remaining runtime and final-cutover gates. PostgreSQL remains authoritative.
