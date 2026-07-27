FROM node:22-slim
ENV NODE_ENV=development
ENV ASSISTANT_REPO_ROOT=/app
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/config ./packages/config
COPY packages/db ./packages/db

RUN pnpm install --frozen-lockfile --filter @assistant/db...
RUN chown -R node:node /app
USER node
CMD ["pnpm", "--filter", "@assistant/db", "reconcile"]
