# The Workspace document-processor job (Cloud Run Job, Phase 14). Credential-free:
# no DB URL, no API keys — only the per-run DOCUMENT_JOB_INPUT env. Reads a
# document's bytes from the Workspace, extracts plain text (office parsing;
# image/scanned-PDF OCR is a follow-up), writes the text back, and calls home.
# The office parsers are pure-JS, so the image needs no system libraries.
FROM node:22-slim
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/document-processor ./workers/document-processor

RUN pnpm install --frozen-lockfile --filter @assistant/document-processor...

RUN groupadd --system docproc && useradd --system --gid docproc --create-home docproc \
  && chown -R docproc:docproc /app /home/docproc

ENV NODE_ENV=production
USER docproc
CMD ["pnpm", "--filter", "@assistant/document-processor", "start"]
