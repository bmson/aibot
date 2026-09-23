# September 23 Firestore data rehearsal

This is a **production-data rehearsal**, not a cutover. PostgreSQL remained writable and authoritative throughout it. The Firestore import is paused behind its migration marker; task claims and schedules are not activated. The final migration needs a new export after the [source write fence](firestore-source-write-fence.md) is proven.

## Pinned source and import

| Evidence | Result |
| --- | --- |
| Export image commit | `78575823aec7b0de4db1982807159a163ece202a` |
| Cloud Run export execution | `assistant-workspace-export-vgq8x` |
| Private snapshot | `gs://bmson-assistant-workspace/workspace/assistant/migration/snapshots/assistant-workspace-export-vgq8x.json` |
| Object generation | `1790148472668678` |
| Object SHA-256 | `d57140413a27d4bc78594dadc43d783d401d0545930417917550e3f746e80a58` |
| Bundle checksum | `7d2c7cc21a6086d60336527e3a67d766066782785cf82176d272b397c949c6c2` |
| Target | `bmson-assistant`, `assistant-rehearsal-20260923b`, installation `assistant` |

The export held 70,372 source records. Cloud Run preview (`assistant-workspace-import-p8ltk`) calculated 17,145 derived metadata records and 87,517 total Firestore writes, including the migration marker. Write (`assistant-workspace-import-t6kcq`) completed with `resumed: false` and `verified: true`. An independent verify-only execution (`assistant-workspace-import-dwxxb`) read the target and reported the same record totals and pinned source checksums. The marker remains `pending_activation`; its completed-write counter is 87,516, excluding the marker itself.

All 70 composite indexes and 19 single-field exemptions were READY on the target. The read-only runtime data preflight returned `ready: true` with no issues for the configured owner, budget, model roles, and legacy 1536-dimensional embedding space. These checks establish import parity for this snapshot, not parity with later PostgreSQL writes.

## Runtime and recovery evidence

A private `assistant-agent-firestore-rehearsal` Cloud Run revision (`assistant-agent-firestore-rehearsal-00002-k48`) booted against this target. Its template has no `DATABASE_URL`, uses `PERSISTENCE_DRIVER=firestore`, local queue mode, minimal modules, and canaries disabled. Its authenticated `/ready` response reported `database: firestore` and `ready: true`. It has no public invoker binding. This establishes a narrow agent boot and owner read; it does not exercise the disabled modules, authenticated web/mobile chat, deliveries, uploads, or a PostgreSQL-offline full application.

Point-in-time recovery was enabled before an official managed Firestore backup. The retained private backup prefix is `gs://bmson-assistant-workspace/workspace/assistant/firestore-backups/rehearsal-20260923b-0746` at snapshot time `2026-09-23T07:46:00Z`. Its manifest records 87,517 installation documents, zero out-of-scope documents, zero external native references, and canonical hash `5f5ff6785b337655ef6c584ebe88716fc0ee920bab8f312d400cfd727bd68fcb`. Google restored it into the separate `assistant-restore-20260923b` database; the independent reader returned exactly 87,517 documents and the same canonical hash. No Cloud Run service or job pointed at that temporary database. It was deleted after verification, and a database lookup returned `NOT_FOUND`. The source rehearsal database, private backup objects, and local manifest were retained.

A second private Cloud Run service, `assistant-web-firestore-rehearsal`, booted on release `faf82adbb72849b38e6a686f9bc28f9dd9ecd230` with the same Firestore target and no `DATABASE_URL` secret. Its service IAM has no public invoker. The health route responded, but authenticated mobile reads exposed two defects: mobile bootstrap exhausted the Next.js process heap under the imported history at the service's 1 GiB memory limit, and the workspace cost projection required a missing descending `(status, createdAt)` index on `costReservations`. The `/api/mobile/v1/chats` route also returned the intentional Firestore-preview `503` gate. The web canary is therefore **not** an end-to-end pass; these findings require code/index changes and a repeat of the same live-data requests.

The repeat used private revision `assistant-web-firestore-rehearsal-00003-gwk`, built from merge commit `da51e7fc94ff4966a7598fd1b18b42001c7ccb7d` for Linux amd64. The service still has no `DATABASE_URL` environment variable or public invoker and retains a 1 GiB memory limit. Authenticated reads against the imported history returned `200` for mobile bootstrap (100 conversation messages, 5.66 s, 185,555 response bytes), activity (3.63 s), cards (0.07 s), people (13.35 s), memory library (25.13 s), commitments (0.18 s), and voice profile (0.66 s). These timings are single warm/cold mixed probes through a local Cloud Run proxy, not latency benchmarks. The bootstrap heap failure and cost-reservation index failure did not recur. Mobile workspace instead returned `500` in 0.64 s with `Profile owner fact count exceeds the view limit`; the bounded profile projection rejects this real owner's larger fact set. A selection fix and repeat probe are required before the workspace route passes. The slow people and library reads also need cost and latency work before cutover.

The asset-reference audit found 27 explicit snapshot references: 10 currently present and 17 already missing from the source (four generated files and 13 completed-import originals). An earlier generation-pinned GCS backup/restore matched all 86 available application assets. The 17 absent originals have preserved database metadata, but their bytes were not recovered by this rehearsal. Check another owner backup or device, or document accepted loss, before claiming every asset migrated.

## Open cutover gates

- Prove a provider-level PostgreSQL write fence and session drain, then take and verify a fresh final export while the fence remains active.
- Complete Firestore composition for every enabled module, web/mobile route, tool, worker, delivery, and management path. Run the full application against migrated data with PostgreSQL unavailable.
- Complete and repeat the bounded owner-fact projection found by the second private web canary; measure the slow people and memory-library reads under the imported history.
- Finish customer-owned installation, authentication, runtime IAM, schedules/queues, and a fresh-account pilot.
- Resolve or explicitly account for the 17 source-missing asset references; verify a final target backup, separate restore, and recovery path.
- Activate exactly one dispatcher only after parity, then verify the live release and absence of PostgreSQL connections and secrets before retiring PostgreSQL.

The live `assistant-web` health endpoint reported release `faf82adbb72849b38e6a686f9bc28f9dd9ecd230` during this rehearsal. That production release still uses PostgreSQL; its healthy response is not Firestore activation evidence.
