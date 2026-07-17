FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm install --frozen-lockfile --filter @assistant/web...
# force-dynamic pages don't touch the DB at build time
RUN pnpm --filter @assistant/web build

ENV NODE_ENV=production
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@assistant/web", "start"]
