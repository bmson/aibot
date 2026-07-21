# The Workspace code-execution job (Cloud Run Job, Phase 13). Credential-free:
# no DB URL, no API keys — only the per-run CODE_JOB_INPUT env. Runs
# model-authored JavaScript (node) or Python (python3) in an ephemeral
# container. Network isolation is enforced at the Cloud Run level (no egress
# connector), not inside the image.
FROM node:22-slim
WORKDIR /app

RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/code-runner ./workers/code-runner

RUN pnpm install --frozen-lockfile --filter @assistant/code-runner...

RUN groupadd --system coderun && useradd --system --gid coderun --create-home coderun \
  && chown -R coderun:coderun /app /home/coderun

ENV NODE_ENV=production
USER coderun
CMD ["pnpm", "--filter", "@assistant/code-runner", "start"]
