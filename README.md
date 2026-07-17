# Assistant ("AI Bot")

A personal AI assistant that is a **separate actor** — its own identity (email `bot@bmson.com`, calendar, phone, cloud Workspace), not a chat feature. It monitors its own inbox, drafts and schedules on your behalf (inviting you to events on *its* calendar), runs long-horizon missions that wake/work/sleep/reflect, and gates every outward-facing action behind your approval.

Architecture plan (v4, the source of truth for design decisions): `~/.claude/plans/i-want-to-build-rippling-lecun.md`.

## Production

- **Web dashboard**: https://assistant-web-3gimfiaifa-uw.a.run.app (Google sign-in, owner-only)
- **Agent worker**: https://assistant-agent-3gimfiaifa-uw.a.run.app
- Stack: Cloud Run (us-west1, scale-to-zero) · Neon Postgres + pgvector · Cloud Tasks (instant task dispatch) · Cloud Scheduler (1-min sweep, daily Gmail watch renewal) · Pub/Sub (Gmail push) · Secret Manager · GCS (Workspace files)
- Deploy/reconcile everything: `bash infra/gcp/deploy.sh` (idempotent; reads `.env`)
- Run cost ≈ $15–30/mo including the Workspace seat; model spend guarded per-task/daily/monthly in-app, plus OpenRouter key limit and a GCP budget alert.

## Layout

- `apps/web` — Next.js: dashboard (approvals/waiting/monitoring/goals), chat with model switcher, tasks audit timeline, goals CRUD
- `apps/agent` — Hono worker: webhooks (Gmail Pub/Sub, Twilio), executor endpoints, local poller, email sync, SMS channel
- `packages/core` — runtime: planner → executor (checkpointed, crash-safe), approvals, missions + reflection, schedules, model router with budget guard, voice pipeline, queue notifier
- `packages/db` — Drizzle schema (22 tables) + migrations + seed
- `packages/tools` — risk-gated tool registry: gmail, calendar, sms, memory (knowledge/experience), web.fetch, workspace (local/GCS), goals, missions
- `infra/` — Dockerfiles, Cloud Build config, deploy script, GCP setup docs
- `scripts/` — `auth-bot.ts` (bot OAuth), `ingest-voice.ts` (writing samples → voice profile), `dev-tunnel.sh`

## Local dev

```sh
docker compose up -d          # postgres+pgvector :5432, fake-gcs :4443
cp .env.example .env          # fill in OPENROUTER_API_KEY at minimum
pnpm install && pnpm db:migrate && pnpm seed
pnpm dev                      # web :3000, agent :8787 (dev-bypass auth)
```

⚠️ The local agent worker polls the same bot mailbox as production — email actions double up while it runs. Keep it off unless testing email flows.

## Commands

- `pnpm test` — vitest across the workspace (integration tests use the local DB)
- `pnpm lint` / `pnpm typecheck` — Biome / tsc
- `pnpm db:generate` / `db:migrate` / `seed`
- `pnpm voice:ingest [--prod]` — ingest writing samples from `seed-data/voice/`
- `pnpm auth:bot` — one-time bot Google OAuth (see `infra/gcp/oauth-setup.md`)

## Security model (enforced in code, not prompts)

Autonomous only inside the bot's own accounts (its inbox/calendar/workspace, public web reads). Outward-facing actions (send email, invite humans, SMS non-owners, browser form-submission) require owner approval — web dashboard or SMS `YES A7`. Tasks triggered by untrusted senders get a reduced tool registry (no outward tools, no memory writes). Approval policies are constrained per-tool templates; every tool call records decision provenance (risk tier, policy, planner/prompt versions, model).
