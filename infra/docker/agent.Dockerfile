FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/agent ./apps/agent

RUN pnpm install --frozen-lockfile --filter @assistant/agent...
RUN pnpm --filter @assistant/agent build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV ASSISTANT_REPO_ROOT=/app
WORKDIR /app

COPY --from=build --chown=node:node /src/apps/agent/dist/index.mjs ./index.mjs
COPY --from=build --chown=node:node /src/apps/agent/dist/index.mjs.map ./index.mjs.map

USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "/app/index.mjs"]
