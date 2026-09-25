import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreMessageRepository,
} from '@assistant/firestore';
import { installModules, noopOwnerNotifier } from '@assistant/modules';
import { embeddingModelId } from '@assistant/persistence';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import type { AgentDeps } from './deps.js';
import { runFirestoreSweep } from './firestore-sweep.js';

const SPACE = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  revision: '1',
};

/** A deterministic unit vector per text, so recall has a known nearest match. */
function vectorFor(text: string): number[] {
  const vector = new Array(1536).fill(0);
  vector[text.length % 1536] = 1;
  return vector;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore message embedding backfill',
  () => {
    const agentId = randomUUID();
    const conversationId = randomUUID();
    let store: InstallationStore;
    let deps: AgentDeps;
    let embedded: string[][];
    let sqlAccesses: string[];

    beforeEach(async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      store = emulatorStore();
      embedded = [];
      sqlAccesses = [];
      const unavailable = (name: string) =>
        new Proxy(
          {},
          {
            get: (_target, property) => {
              sqlAccesses.push(`${name}.${String(property)}`);
              throw new Error(`Unexpected ${name} access: ${String(property)}`);
            },
          },
        );
      const config = {
        ...loadConfig({}),
        PERSISTENCE_DRIVER: 'firestore' as const,
        FIRESTORE_AGENT_ID: agentId,
        FIRESTORE_EMBEDDING_SPACE: JSON.stringify(SPACE),
        ASSISTANT_MODULES: [],
      };
      const persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      const db = unavailable('db') as Db;
      deps = {
        config,
        db,
        firestoreStore: store,
        firestoreTasks: persistence.tasks,
        persistence,
        router: {
          embed: async (texts: string[]) => {
            embedded.push(texts);
            return texts.map(vectorFor);
          },
        } as never,
        registry: new ToolRegistry(),
        dispatcher: unavailable('dispatcher') as never,
        workspace: unavailable('workspace') as never,
        modules: installModules([], {
          config,
          db,
          registry: new ToolRegistry(),
          repoRoot: '/tmp/test',
          router: unavailable('router') as never,
          workspace: unavailable('workspace') as never,
          workspacePrefix: 'workspace/test',
          workspaceRoot: '/tmp/test',
          persistence,
        }),
        outOfBandNotifier: noopOwnerNotifier,
      };
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
      await store.doc('modelRoles', 'embed').set({
        role: 'embed',
        primaryModel: embeddingModelId(SPACE),
        fallbackModels: [],
      });
      await store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Chat',
        isPrimary: true,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    afterEach(async () => {
      await disposeStore(store);
      vi.unstubAllEnvs();
    });

    async function append(role: 'user' | 'assistant' | 'system', text: string) {
      const row = await new FirestoreMessageRepository(store).append({
        conversationId,
        role,
        origin: role === 'user' ? 'owner' : 'assistant',
        parts: [{ type: 'text', text }],
        text,
      });
      if (!row) throw new Error('message was not appended');
      return row.id;
    }

    it('embeds new recall candidates once so historical recall can find them', async () => {
      const candidate = await append('user', 'We booked the cabin at Lake Tahoe for March.');
      const short = await append('assistant', 'Sounds good.');
      const system = await append(
        'system',
        'A system note long enough to embed but never recalled.',
      );

      const first = await runFirestoreSweep(deps);
      expect(first).toMatchObject({ ready: true, report: { messagesEmbedded: 1 } });
      expect(embedded).toEqual([['We booked the cabin at Lake Tahoe for March.']]);
      const stored = await store.doc('messages', candidate).get();
      expect(stored.get('embeddingPending')).toBeUndefined();
      expect(stored.get('embeddingSpace')).toEqual(expect.any(String));
      for (const id of [short, system]) {
        expect((await store.doc('messages', id).get()).get('embeddingPending')).toBeUndefined();
      }

      const recalled = await deps.persistence?.history.messages({
        agentId,
        embedding: vectorFor('We booked the cabin at Lake Tahoe for March.'),
        exclude: { conversationId: randomUUID(), sinceCreatedAt: new Date() },
        limit: 3,
      });
      expect(recalled?.map((row) => row.id)).toEqual([candidate]);

      // Nothing left to embed: the next pass makes no model call.
      expect(await runFirestoreSweep(deps)).toMatchObject({ report: { messagesEmbedded: 0 } });
      expect(embedded).toHaveLength(1);
      expect(sqlAccesses).toEqual([]);
    });

    it('refuses vectors from a model other than the configured embedding space', async () => {
      await append('user', 'A message that must not be embedded in another space.');
      await store
        .doc('modelRoles', 'embed')
        .update({ primaryModel: 'google/gemini-embedding-001' });

      expect(await runFirestoreSweep(deps)).toMatchObject({ report: { messagesEmbedded: 0 } });
      expect(embedded).toEqual([]);
      const pending = await store
        .collection('messages')
        .where('embeddingPending', '==', true)
        .get();
      expect(pending.size).toBe(1);
      expect(sqlAccesses).toEqual([]);
    });
  },
);
