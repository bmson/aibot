FROM node:26-slim
ENV NODE_ENV=development
ENV ASSISTANT_REPO_ROOT=/app
WORKDIR /app
RUN corepack enable

# Manifests first: dependency layers survive source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @assistant/db...

COPY packages/config ./packages/config
COPY packages/db ./packages/db
RUN chown -R node:node /app
# Runtime uses pnpm via corepack, never npm. Strip the base image's bundled npm
# so its vendored deps (tar/sigstore/brace-expansion/picomatch, all HIGH/
# CRITICAL) don't ship or fail the deploy vulnerability scan. Also strip the
# corepack download cache the root-run install left under /root: the runtime
# user can't read /root (mode 700) — corepack resolves its own per-user cache —
# so the copy is dead weight that only feeds pnpm advisories to the scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /root/.cache/node
USER node
CMD ["pnpm", "--filter", "@assistant/db", "reconcile"]
