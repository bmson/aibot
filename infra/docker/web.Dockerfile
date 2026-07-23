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

# The released commit, surfaced by /api/health so release.sh can prove the live
# revision is the one it just pushed. Declared after the build on purpose: it
# changes every commit, and /api/health reads it at request time (force-dynamic,
# not NEXT_PUBLIC_), so keeping it below the build leaves the layer cache intact.
ARG GIT_SHA=unknown
ENV BUILD_SHA=${GIT_SHA}

RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@assistant/web", "start"]
