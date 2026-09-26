# Firestore web and mobile route inventory

Snapshot of `apps/web` at `ce13c5fc` (2026-09-23). It answers one question for every page, route handler, and Server Action: with `PERSISTENCE_DRIVER=firestore` and no `DATABASE_URL`, does it work without SQL? Production still runs on PostgreSQL; nothing here changes that composition.

How the Firestore composition is gated today:

- `apps/web/proxy.ts` is an allowlist. Any path/method it does not list returns `503 {"code":"unavailable"}` in Firestore mode, before authentication or the handler runs.
- `getDb()` in `apps/web/lib/server.ts` throws `PostgreSQL-backed web surface is unavailable in Firestore mode`. Anything reaching `getApplication()`, `getRouter()`, or a `*(getDb(), …)` call in Firestore mode fails with a 500.
- Some handlers check the driver themselves and return `501`, `503`, or `409` with an "unavailable in Firestore" message, or render a read-only variant of the page.

Classification:

| Class | Meaning |
|---|---|
| **Ready** | Proxy passes it and every action it offers has a Firestore path. |
| **Degraded** | Proxy passes it and it has a Firestore path, but some actions are refused, hidden, or the page renders read-only. |
| **Gated** | Proxy blocks it, but the handler itself needs no SQL (unblocking is enough). |
| **SQL** | The Firestore composition would reach PostgreSQL; a portable port is required. Most are also proxy-blocked. |

## Summary

| Surface | Total | Ready | Degraded | Gated | SQL |
|---|---:|---:|---:|---:|---:|
| Mobile API handlers (`/api/mobile/v1`, per method) | 82 | 70 | 4 | 1 | 7 |
| Web API handlers (`/api`, per method) | 14 | 9 | 0 | 2 | 3 |
| Pages (27 `page.tsx`) | 27 | 14 | 8 | 1 | 4 |
| Server Action modules (17) | 17 | 10 | 4 | 0 | 3 |

"Degraded" pages count as working for reads; each lists what is still missing below.

## Mobile API (`/api/mobile/v1`)

Ready (70 handlers): `activity` GET/POST, `activity/[id]` POST, `activity/foreground` POST, `anomalies/[id]` POST, `approvals/[id]` POST, `bootstrap` GET, `cards` GET, `cards/[id]` POST, `chat` POST, `chat/status` GET, `chats` POST, `chats/[id]` GET/POST, `chats/[id]/messages/[messageId]` POST, `costs` PATCH, `documents` GET, `documents/[id]` GET, `goals` GET/POST, `goals/[id]` GET/PATCH/POST, `imports` POST, `knowledge` GET/POST, `knowledge/[id]` GET/PATCH, `knowledge/cleanup` GET/POST, `knowledge/graph` GET, `knowledge/relations/[id]` GET/POST/DELETE, `knowledge/sources/[id]` GET/PATCH/DELETE, `knowledge/workspace` GET, `mcp` GET/POST, `mcp/[id]` POST/DELETE, `memory/commitments` GET/POST, `memory/export` GET, `memory/library` GET, `memory/occasions/[id]` POST/PATCH/DELETE, `memory/people` POST, `memory/people/[id]` GET/PATCH, `memory/people/[id]/occasions` POST, `memory/profile` GET, `overview` GET, `packs` GET/POST, `people` GET, `people/[id]` GET, `settings` PATCH, `settings/policies/[id]` POST/DELETE, `settings/reminders/[id]` DELETE, `settings/schedules/[id]` POST, `skills` POST, `skills/[id]` PATCH/POST/DELETE, `suggestions/[id]` POST, `workspace` GET.

Degraded (4):

| Handler | Missing in Firestore mode |
|---|---|
| `documents` POST | Returns `501`. Text uploads are in flight in PR #360. |
| `documents/[id]` DELETE | Returns `501`; no portable document/chunk/file/bytes deletion. |
| `improvements/[id]` POST | `apply` on a `model_role` proposal throws ("require PostgreSQL model and role records"); dismiss and advisory apply work. |
| `memory/profile` POST | Every action works in Firestore mode; `purge-voice` runs through `FirestoreVoiceSamplePurgeRepository`. |

Gated (1): `live/scoreboard` GET (reads only the agent timezone, which already has a Firestore path).

SQL (7):

| Handler | SQL dependency |
|---|---|
| `devices` POST | `registerDeviceToken(db)` → `upsertDeviceToken` |
| `location` POST | `recordOwnerLocationPing(db)` → location ping + arrival nudge task |
| `memory` POST | `createMemory` (profile memory commands bound to `db`) |
| `memory/[id]` PATCH, POST | `correctMemory`, confirm, approve, reject, forget, prominence (profile memory commands bound to `db`) |
| `memory/people/[id]` POST, DELETE | people merge/delete; explicit `409` in Firestore mode |

## Web API (`/api`)

| Handler | Class | Notes |
|---|---|---|
| `auth/[...nextauth]` GET, POST | Ready | |
| `card-image` GET | Ready | No persistence. |
| `chat` POST, `chat/status` GET | Ready | `getChatApplication()` |
| `health` GET | Ready | |
| `profile-export` GET | Ready | `FirestorePrivacyExportRepository` |
| `shell/status` GET | Ready | |
| `live/scoreboard` GET | Gated | Same as the mobile route. |
| `maps/snapshot` GET | Gated | No persistence at all. |
| `ready` GET | SQL | `checkReadiness(db)` runs `select 1`. |
| `files` GET | SQL | `downloadArtifact(db, workspace)` checks a `files` row. |
| `documents/upload` POST | SQL | `uploadDocument(db, workspace)` |
| `import/upload` POST | Ready | `getImportCommands()`; bytes go to the workspace store, records to Firestore. A voice upload returns to `/profile/voice`. |

## Pages

| Page | Class | Notes |
|---|---|---|
| `/` | Ready | Redirect. |
| `/approvals` | Ready | `getApprovalStore()` |
| `/capabilities` | Ready | |
| `/cards` | Ready | |
| `/chat`, `/chat/all` | Ready | |
| `/costs` | Ready | |
| `/goals` | Ready | |
| `/packs` | Ready | |
| `/skills` | Ready | |
| `/tasks` | Ready | Archive/restore/archive-old actions are portable. |
| `/profile/data` | Ready | Firestore privacy export and erasure. |
| `/profile/knowledge` | Ready | One bounded Firestore snapshot serves the header, library, map, entity focus, and cleanup views. |
| `/chat/[id]` | Degraded | `firestorePreview` hides inline approval, budget and suggestion decisions, recall feedback, card refresh, the Stop button and the Activity link. |
| `/tasks/[id]` | Degraded | Retry, revoke autonomy, raise budget and cancel call `getDb()`. |
| `/settings` | Degraded | Read-only: no mobile pairing/token rotation (explicitly refused, though it needs no SQL) and no proactive-health panel. |
| `/import` | Ready | Upload, start, purge, delete and review run through `getImportCommands()`. |
| `/profile/memories` | Degraded | Read-only memory hub substituted for `/profile`. |
| `/profile/about` | Degraded | Read-only owner facts; confirm/correct/forget unavailable. |
| `/profile/voice` | Ready | Profile edit, sample upload and voice-sample purge (`FirestoreVoiceSamplePurgeRepository`) work. |
| `/people`, `/people/[id]` | Degraded | Read-only directory and contact detail; POST (people Server Actions) proxy-blocked. |
| `/profile/people/[id]` | Gated | Pure redirect to `/people/[id]`. |
| `/anomalies` | SQL | `listAnomalies(db)`; Firestore repository already exists. |
| `/improvements` | SQL | `listImprovementProposals(db)`; Firestore repository already exists. |
| `/documents` | SQL | `getDocumentsOverview(db)` |
| `/profile` | SQL | memory hub overview, commitments, recall feedback summary |

## Server Actions

| Module | Class | SQL-only actions in Firestore mode |
|---|---|---|
| `app/actions.ts` | Ready | |
| `approvals/actions.ts` | Ready | |
| `cards/actions.ts` | Ready | |
| `costs/actions.ts` | Ready | |
| `goals/actions.ts` | Ready | |
| `import/actions.ts` | Ready | |
| `packs/actions.ts` | Ready | |
| `profile/knowledge/actions.ts` | Ready | Graph curation (rename, retype, merge, orphan removal, source retry and re-extraction) uses `FirestoreKnowledgeGraphCurationRepository`. |
| `skills/actions.ts` | Ready | |
| `suggestions/actions.ts` | Ready | |
| `chat/actions.ts` | Degraded | `recordRecallFeedbackAction` |
| `tasks/actions.ts` | Degraded | `retryTask`, `revokeAutonomyGrant`, `raiseTaskBudgetAndRetry`, `cancelTask` |
| `settings/actions.ts` | Degraded | `rotateMobileToken` explicitly refused |
| `profile/actions.ts` | Degraded | commitments (resolve/dismiss/snooze/correct), memory commands (confirm/correct/forget/prominence/approve/reject/create), organize, merge/delete people (explicitly refused). People, occasions, voice profile, card recompile and erase are portable. |
| `anomalies/actions.ts` | SQL | dismiss, suspend policy |
| `improvements/actions.ts` | SQL | apply, dismiss |
| `documents/actions.ts` | SQL | delete document |

## Structural gap

`apps/web/lib/server.ts` statically imports `createDb` and the PostgreSQL card repositories from `@assistant/db`, and `@assistant/application`'s barrel re-exports SQL use cases. The Firestore composition therefore still loads the Drizzle/`postgres` modules even when no SQL call runs. Removing that reachability needs the PostgreSQL facade moved behind a lazily imported module and Firestore-only entry points for the application barrel; it is tracked here rather than attempted per domain.

## Porting order

The routes above are ported one domain per PR, each with emulator tests in `pnpm test:firestore`:

1. Task activity commands (`/tasks/[id]` actions) and chat inline actions, including recall feedback, so `/chat/[id]` no longer needs `firestorePreview`.
2. Anomalies and improvements pages and actions (repositories already exist).
3. Profile memory commands (web profile actions, mobile `memory`, `memory/[id]`, `knowledge/sources/[id]` PATCH/DELETE).
4. SQL-free routes that only need unblocking (`live/scoreboard`, `maps/snapshot`, `/profile/people/[id]`, mobile token rotation).
5. Device registration, location pings, readiness.
6. Remaining: documents deletion, people merge/delete, memory organize/purge, `model_role` improvements, `/profile`, and the structural gap.
