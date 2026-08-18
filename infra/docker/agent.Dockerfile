FROM node:26-slim AS build
WORKDIR /src
RUN corepack enable

# Manifests first: dependency layers survive source edits, so a one-line code
# change re-runs the build step but not the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/application/package.json ./packages/application/
COPY packages/tools/package.json ./packages/tools/
COPY packages/modules/package.json ./packages/modules/
COPY packages/setup/package.json ./packages/setup/
COPY apps/agent/package.json ./apps/agent/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @assistant/agent...

# The composition file is agent source: it decides which modules are compiled in.
COPY assistant.config.ts ./
COPY packages ./packages
COPY apps/agent ./apps/agent
RUN pnpm --filter @assistant/agent build

FROM node:26-slim AS runtime
ENV NODE_ENV=production
ENV ASSISTANT_REPO_ROOT=/app
WORKDIR /app

COPY --from=build --chown=node:node /src/apps/agent/dist/index.mjs ./index.mjs
COPY --from=build --chown=node:node /src/apps/agent/dist/index.mjs.map ./index.mjs.map

# unpdf is external to the bundle (it alone was 28% of it, and PDF extraction
# is rare in-agent), so the runtime installs exactly that one package.
RUN npm install --no-save --omit=dev unpdf@1.6.2 && chown -R node:node /app/node_modules

# npm is only needed for the install above, never at runtime (the app runs on
# node directly). Strip it so the base image's bundled npm — whose vendored deps
# tar/sigstore/brace-expansion/picomatch carry HIGH/CRITICAL CVEs — neither ships
# in the released image nor fails the deploy vulnerability scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "/app/index.mjs"]
