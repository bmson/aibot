# Assistant

A personal AI assistant that is a **separate actor** — its own identity (email, calendar, phone, workspace), not a chat feature. See `~/.claude/plans/i-want-to-build-rippling-lecun.md` for the full architecture plan.

## Layout

- `apps/web` — Next.js: dashboard home, chat, approvals, tasks, goals, settings
- `apps/agent` — Hono service: webhooks (Twilio, Gmail Pub/Sub), workflow executor, internal API
- `packages/core` — agent runtime: planner, executor, tool dispatcher/risk gate, model router, channels, voice
- `packages/db` — Drizzle schema + migrations (Postgres 17 + pgvector)
- `packages/tools` — tool registry (gmail, calendar, sms, browser, memory, workspace, web, goals)
- `workers/browser-job` — Playwright container (Cloud Run Job)
- `infra/gcp` — GCP setup
- `scripts` — seed, auth-bot (bot OAuth), dev-tunnel

## Local dev

```sh
docker compose up -d          # postgres+pgvector :5432, fake-gcs :4443
cp .env.example .env          # then fill in OPENROUTER_API_KEY at minimum
pnpm install
pnpm db:migrate
pnpm seed
pnpm dev                      # web :3000, agent :8787
```

## Commands

- `pnpm dev` — run web + agent in watch mode
- `pnpm test` — vitest across workspace
- `pnpm lint` / `pnpm format` — biome
- `pnpm typecheck` — tsc across workspace
- `pnpm db:generate` — generate migrations from schema changes
- `pnpm db:migrate` — apply migrations
- `pnpm seed` — seed agent identity, models, roles, budgets, owner contact
