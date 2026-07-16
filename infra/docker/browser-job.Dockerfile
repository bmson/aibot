# The Workspace browser job (Cloud Run Job). Credential-free: no DB URL, no
# API keys — only PROFILE_ENC_KEY (Secret Manager) and per-run BROWSER_JOB_INPUT.
FROM node:22-slim
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/browser-job ./workers/browser-job

RUN pnpm install --frozen-lockfile --filter @assistant/browser-job...
# Chromium + OS deps, version-matched to the installed playwright package
RUN pnpm --filter @assistant/browser-job exec playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@assistant/browser-job", "start"]
