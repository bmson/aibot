FROM node:22-slim
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/agent ./apps/agent

RUN pnpm install --frozen-lockfile --filter @assistant/agent...

ENV NODE_ENV=production
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@assistant/agent", "start"]
