# The Workspace document-processor job (Cloud Run Job, Phase 14). Credential-free:
# no DB URL, no API keys — only the per-run DOCUMENT_JOB_INPUT env. Reads a
# document's bytes from the Workspace, extracts plain text (office parsing plus
# OCR for images and scanned PDFs), writes the text back, and calls home.
FROM node:22-slim
WORKDIR /app

# tesseract (OCR) + poppler (pdftoppm rasterizes scanned PDFs page-by-page).
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY workers/document-processor ./workers/document-processor

RUN pnpm install --frozen-lockfile --filter @assistant/document-processor...

RUN groupadd --system docproc && useradd --system --gid docproc --create-home docproc \
  && chown -R docproc:docproc /app /home/docproc

ENV NODE_ENV=production
USER docproc
CMD ["pnpm", "--filter", "@assistant/document-processor", "start"]
