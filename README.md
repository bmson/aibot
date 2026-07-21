# Assistant ("AI Bot")

A personal AI assistant that is a **separate actor** — its own identity (email `bot@bmson.com`, calendar, phone, cloud Workspace), not a chat feature. It monitors its own inbox, drafts and schedules on your behalf (inviting you to events on *its* calendar), runs long-horizon missions that wake/work/sleep/reflect, and gates every outward-facing action behind your approval.

Architecture plan (v4, the source of truth for design decisions): `~/.claude/plans/i-want-to-build-rippling-lecun.md` (kept outside the repo). In-repo design notes live in [`docs/`](docs/).

## Production

- **Web dashboard**: https://assistant-web-3gimfiaifa-uw.a.run.app (Google sign-in, owner-only)
- **Agent worker**: https://assistant-agent-3gimfiaifa-uw.a.run.app
- Stack: Cloud Run (us-west1, scale-to-zero) · Neon Postgres + pgvector · Cloud Tasks (instant task dispatch) · Cloud Scheduler (1-min sweep, daily Gmail watch renewal) · Pub/Sub (Gmail push) · Secret Manager · GCS (Workspace files)
- First provision/reconcile everything: `bash infra/gcp/deploy.sh` (idempotent; reads `.env`). Normal releases: `bash infra/gcp/release.sh` (no `.env`; uses only existing Cloud Run configuration). Merges to `main` run the same release path after CI through keyless GitHub OIDC; see [`infra/gcp/github-actions.md`](infra/gcp/github-actions.md).
- Run cost ≈ $15–30/mo including the Workspace seat; model spend guarded per-task/daily/monthly in-app, plus OpenRouter key limit and a GCP budget alert.

## Layout

- `apps/web` — Next.js: dashboard (approvals/waiting/monitoring/goals), chat with model switcher, tasks audit timeline, goals CRUD
- `apps/agent` — Hono worker: webhooks (Gmail Pub/Sub, Twilio), executor endpoints, local poller, email sync, SMS channel
- `packages/core` — runtime: planner → executor (checkpointed, crash-safe), approvals, missions + reflection, schedules, model router with budget guard, voice pipeline, queue notifier
- `packages/db` — Drizzle schema (33 tables) + migrations + seed
- `packages/tools` — risk-gated tool registry: Gmail, Calendar, Docs/Sheets/Slides, Drive search + attachment staging, browser plans, SMS, memory, public web fetch, Workspace, goals, missions
- `infra/` — Dockerfiles, Cloud Build config, deploy script, GCP setup docs
- `scripts/` — `auth-bot.ts` (bot OAuth), `ingest-voice.ts` (writing samples → voice profile), `dev-tunnel.sh`

## Local dev

```sh
docker compose up -d          # postgres+pgvector :5432, fake-gcs :4443
cp .env.example .env          # fill in OPENROUTER_API_KEY at minimum
pnpm install && pnpm db:migrate && pnpm seed
pnpm dev                      # web :3000, agent :8787
```

The checked-in `.env.example` explicitly enables the local-only web auth bypass and internal
shared-secret mode. Remove `AUTH_DEV_BYPASS=true` to exercise fail-closed web auth locally; the
bypass is rejected when `NODE_ENV=production`. To call `/internal/*` by hand, generate a local
`INTERNAL_API_SECRET` with `openssl rand -hex 32`; blank secrets are always rejected.

⚠️ The local agent worker polls the same bot mailbox as production — email actions double up while it runs. Keep it off unless testing email flows.

## Commands

- `pnpm test` — vitest across the workspace (integration tests use the local DB)
- `pnpm lint` / `pnpm typecheck` — Biome / tsc
- `pnpm db:generate` / `db:migrate` / `seed`
- `pnpm voice:ingest [--prod]` — ingest writing samples from `seed-data/voice/`
- `pnpm auth:bot` — one-time bot Google OAuth (see `infra/gcp/oauth-setup.md`)

## Deployment canaries

`POST /internal/canaries/run` performs real, uniquely marked Gmail, sandboxed browser, approval,
and chat checks, plus SMS when Twilio and `OWNER_PHONE` are configured. An unavailable optional
SMS integration is explicitly reported as skipped. `GET /internal/canaries/status` returns the
latest durable JSON result;
`GET /internal/canaries/health` returns 503 for failed, stuck, missing, or >26-hour-old results.
Both endpoints use the same OIDC/shared-secret protection as every other internal route.

Canaries are disabled by default because a run sends one SMS to `OWNER_PHONE`. Production deploys
set `CANARY_ENABLED=true`, enforce a `$0.03` structural run ceiling in addition to the global cost
ledger, and schedule one run daily. Runs are single-flight across Cloud Run instances, every check
has a deadline, Gmail artifacts are moved to Trash, browser callbacks use a one-shot token hash, and
synthetic approvals/tasks are always driven to a terminal state.
An hourly authenticated health probe logs `canary_alert` and fails its Scheduler execution when
the result needs attention, while the dashboard shows the same health state to the owner.

Local example (with the agent running and a non-empty `INTERNAL_API_SECRET`):

```sh
# Set CANARY_ENABLED=true in .env only when the real provider side effects are intended.
curl -X POST http://localhost:8787/internal/canaries/run \
  -H "Authorization: Bearer $INTERNAL_API_SECRET"
curl http://localhost:8787/internal/canaries/status \
  -H "Authorization: Bearer $INTERNAL_API_SECRET"
```

## Security model (enforced in code, not prompts)

Autonomous only inside the bot's own accounts (its inbox/calendar/workspace, public web reads). Outward-facing actions (send email, invite humans, SMS non-owners, browser form entry, uploads, and submission) require owner approval — web dashboard or SMS `YES A7`. A Drive file can be staged only in the browser's purpose-limited attachment area; the isolated browser worker cannot read the rest of the Workspace. Tasks triggered by untrusted senders get a reduced tool registry (no outward tools, no memory writes). Approval policies are constrained per-tool templates; every tool call records decision provenance (risk tier, policy, planner/prompt versions, model).
