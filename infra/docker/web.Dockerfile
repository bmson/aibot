FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable

# Manifests first: dependency layers survive source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/application/package.json ./packages/application/
COPY packages/tools/package.json ./packages/tools/
COPY packages/modules/package.json ./packages/modules/
COPY packages/setup/package.json ./packages/setup/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @assistant/web...

COPY packages ./packages
COPY apps/web ./apps/web
ARG GIT_SHA=unknown
ENV BUILD_SHA=${GIT_SHA}
RUN pnpm --filter @assistant/web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
ENV ASSISTANT_REPO_ROOT=/app
WORKDIR /app

COPY --from=build --chown=node:node /src/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /src/apps/web/.next/static ./apps/web/.next/static

ARG GIT_SHA=unknown
ENV BUILD_SHA=${GIT_SHA}
USER node
EXPOSE 8080
CMD ["node", "/app/apps/web/server.js"]
