import { randomUUID } from 'node:crypto';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordDocumentProcessorResult,
  runDocumentProcessing,
} from '../../../packages/core/src/memory/document-processor.js';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = {
  provider: 'synthetic',
  model: 'processor-fixture',
  dimensions: 1536,
  revision: '1',
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore document processor lifecycle',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let launches: Array<{ documentId: string; callbackToken: string; workspacePath: string }>;
    const db = new Proxy({} as Db, {
      get: (_target, property) => {
        throw new Error(`PostgreSQL access in Firestore test: ${String(property)}`);
      },
    });

    beforeEach(async () => {
      store = emulatorStore();
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      launches = [];
      await store.doc('agents', agentId).set({ id: agentId, name: 'Ada', timezone: 'UTC' });
      await store.doc('rateLimits', 'task').set({
        scope: 'task',
        maxPerHour: null,
        maxPerDay: null,
        updatedAt: new Date(),
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function pdf(extra: Record<string, unknown> = {}) {
      const id = randomUUID();
      const fileId = randomUUID();
      const now = new Date();
      await store.doc('files', fileId).set(
        encodeRecord({
          id: fileId,
          agentId,
          taskId: null,
          workspacePath: `documents/uploads/${fileId}-report.pdf`,
          mime: 'application/pdf',
          bytes: 100,
          sha256: randomUUID(),
          createdAt: now,
        }),
      );
      await store.doc('documents', id).set(
        encodeRecord({
          id,
          agentId,
          fileId,
          title: 'Report',
          mime: 'application/pdf',
          source: 'upload',
          sourceRef: '',
          trust: 'owner',
          sha256: randomUUID(),
          status: 'pending',
          extractor: 'pending_processor',
          chunkCount: 0,
          charCount: 0,
          error: null,
          processorTokenHash: null,
          processorStartedAt: null,
          processorAttempts: 0,
          processedTextPath: null,
          createdAt: now,
          updatedAt: now,
          ...extra,
        }),
      );
      return id;
    }

    function run(documentId?: string) {
      return runDocumentProcessing(
        {
          db,
          ...(persistence.documentProcessor
            ? { processorStore: persistence.documentProcessor }
            : {}),
          documentProcessor: {
            callbackUrl: 'https://agent.test/webhooks/document/callback',
            launcher: {
              launch: async (input: {
                documentId: string;
                callbackToken: string;
                source: { workspacePath: string };
              }) => {
                launches.push({
                  documentId: input.documentId,
                  callbackToken: input.callbackToken,
                  workspacePath: input.source.workspacePath,
                });
                return { executionName: 'run-1' };
              },
            },
          },
        },
        {
          trigger: { payload: documentId ? { job: 'documents.process', documentId } : {} },
        } as never,
      );
    }

    const callback = (
      documentId: string,
      token: string,
      result: { ok: boolean; kind?: string },
    ) => {
      const processor = persistence.documentProcessor;
      if (!processor) throw new Error('missing processor repository');
      return recordDocumentProcessorResult(
        { processor, tasks: persistence.tasks },
        { documentId, token, result },
      );
    };

    it('launches once, accepts the one-shot callback, and hands the text to extraction', async () => {
      const id = await pdf();
      expect((await run(id)).summary).toBe('document processor: 1 launched');
      expect((await run(id)).summary).toBe('document processor: 0 launched');
      const [launch] = launches;
      expect(launch?.workspacePath).toContain('-report.pdf');

      expect(await callback(id, 'wrong-token', { ok: true })).toEqual({
        ok: false,
        status: 403,
        error: 'invalid token',
      });
      expect(await callback(id, launch?.callbackToken ?? '', { ok: true })).toEqual({
        ok: true,
        documentId: id,
        enqueued: true,
      });
      expect(await callback(id, launch?.callbackToken ?? '', { ok: true })).toMatchObject({
        ok: false,
        status: 409,
      });
      const doc = (await store.doc('documents', id).get()).data();
      expect(doc?.processedTextPath).toBe(`documents/${id}/extracted.txt`);
      const extract = await store
        .collection('tasks')
        .where('trigger.payload.documentId', '==', id)
        .get();
      expect(extract.docs.map((task) => task.get('trigger').payload.job)).toEqual([
        'documents.extract',
      ]);
    });

    it('records an unsupported format, retires exhausted runs, and relaunches stale ones', async () => {
      const unsupported = await pdf();
      await run(unsupported);
      await callback(unsupported, launches[0]?.callbackToken ?? '', {
        ok: false,
        kind: 'unsupported',
      });
      expect((await store.doc('documents', unsupported).get()).get('status')).toBe('unsupported');

      const exhausted = await pdf({ processorAttempts: 3 });
      const stale = await pdf({
        processorAttempts: 1,
        processorStartedAt: new Date(Date.now() - 6 * 3_600_000),
        processorTokenHash: 'old',
      });
      launches = [];
      expect((await run()).summary).toBe('document processor: 1 launched');
      expect((await store.doc('documents', exhausted).get()).get('status')).toBe('failed');
      expect(launches.map((launch) => launch.documentId)).toEqual([stale]);
      expect((await store.doc('documents', stale).get()).get('processorAttempts')).toBe(2);
    });
  },
);
