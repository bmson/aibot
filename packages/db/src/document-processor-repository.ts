import type { DocumentProcessorRepository } from '@assistant/persistence';
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { documents, files } from './schema.js';

/** The processor lifecycle with the queries `documents.process` and its callback always ran. */
export function createPostgresDocumentProcessorRepository(db: Db): DocumentProcessorRepository {
  const claimable = (staleBefore: Date) =>
    or(isNull(documents.processorStartedAt), lt(documents.processorStartedAt, staleBefore));
  return {
    kind: 'document-processor-repository',
    async retireExhausted(maxAttempts) {
      const retired = await db
        .update(documents)
        .set({
          status: 'failed',
          processorTokenHash: null,
          error: `processor did not report back after ${maxAttempts} launches`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documents.extractor, 'pending_processor'),
            eq(documents.status, 'pending'),
            gte(documents.processorAttempts, maxAttempts),
          ),
        )
        .returning({ id: documents.id });
      return retired.length;
    },
    claimable: (input) =>
      db
        .select({
          id: documents.id,
          agentId: documents.agentId,
          title: documents.title,
          mime: documents.mime,
          extractor: documents.extractor,
          workspacePath: files.workspacePath,
        })
        .from(documents)
        .innerJoin(files, eq(files.id, documents.fileId))
        .where(
          and(
            eq(documents.extractor, 'pending_processor'),
            eq(documents.status, 'pending'),
            claimable(input.staleBefore),
            ...(input.documentId ? [eq(documents.id, input.documentId)] : []),
          ),
        )
        .limit(input.limit),
    async claim(id, input) {
      const [claimed] = await db
        .update(documents)
        .set({
          processorTokenHash: input.tokenHash,
          processorStartedAt: input.now,
          processorAttempts: sql`${documents.processorAttempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(documents.id, id),
            eq(documents.extractor, 'pending_processor'),
            eq(documents.status, 'pending'),
            claimable(input.staleBefore),
          ),
        )
        .returning({ id: documents.id });
      return Boolean(claimed);
    },
    async release(id) {
      await db
        .update(documents)
        .set({ processorTokenHash: null, processorStartedAt: null, updatedAt: sql`now()` })
        .where(eq(documents.id, id));
    },
    recordResult: (input) =>
      db.transaction(async (tx) => {
        const [doc] = await tx
          .select()
          .from(documents)
          .where(eq(documents.id, input.documentId))
          .for('update');
        if (!doc) return { ok: false, status: 404, error: 'document not found' } as const;
        if (!doc.processorTokenHash)
          return { ok: false, status: 409, error: 'no pending processor run' } as const;
        if (!input.tokenMatches(doc.processorTokenHash))
          return { ok: false, status: 403, error: 'invalid token' } as const;
        if (input.ok) {
          await tx
            .update(documents)
            .set({
              processedTextPath: input.processedTextPath,
              processorTokenHash: null,
              error: null,
              updatedAt: sql`now()`,
            })
            .where(eq(documents.id, doc.id));
          return { ok: true, documentId: doc.id, agentId: doc.agentId, extract: true } as const;
        }
        await tx
          .update(documents)
          .set({
            status: input.unsupported ? 'unsupported' : 'failed',
            processorTokenHash: null,
            error: input.error.slice(0, 2000),
            updatedAt: sql`now()`,
          })
          .where(eq(documents.id, doc.id));
        return { ok: true, documentId: doc.id, agentId: doc.agentId, extract: false } as const;
      }),
  };
}
