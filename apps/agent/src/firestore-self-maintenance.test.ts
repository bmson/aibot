import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = { provider: 'synthetic', model: 'maintain-fixture', dimensions: 1536, revision: '1' };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore self-maintenance backlog job',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: ExecutorDeps;
    let prompts: string[];
    const now = new Date();
    const items = [
      {
        codeShaped: true,
        title: 'Guard the empty browse result',
        diagnosis: 'browse returns undefined for an empty page',
        targetArea: 'packages/core/src/browse.ts',
      },
      {
        codeShaped: true,
        title: 'Loosen the approval gate',
        diagnosis: 'too many prompts',
        targetArea: 'packages/tools/src/dispatcher.ts',
      },
      { codeShaped: true, title: 'Unplaced fix', diagnosis: 'somewhere', targetArea: '' },
      { codeShaped: false, title: 'Use a bigger model', diagnosis: '', targetArea: '' },
    ];

    beforeEach(async () => {
      store = emulatorStore();
      prompts = [];
      const unavailable = (name: string) =>
        new Proxy(
          {},
          {
            get: (_target, property) => {
              throw new Error(`Unexpected ${name} access: ${String(property)}`);
            },
          },
        );
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      const router = {
        async object(_role: string, input: { prompt: string }) {
          prompts.push(input.prompt);
          return { ok: true, modelId: 'fixture', degraded: false, object: { items } };
        },
      };
      deps = {
        db: unavailable('db') as Db,
        router: router as unknown as ExecutorDeps['router'],
        dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
        persistence,
      };
      await store.doc('agents', agentId).set(
        encodeRecord({
          id: agentId,
          name: 'Ada',
          timezone: 'UTC',
          createdAt: now,
          updatedAt: now,
        }),
      );
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function proposal(input: { title: string; status?: string; agent?: string }) {
      const id = randomUUID();
      await store.doc('improvementProposals', id).set(
        encodeRecord({
          id,
          agentId: input.agent ?? agentId,
          title: input.title,
          status: input.status ?? 'open',
          kind: 'bug',
          rationale: `Because ${input.title}`,
          change: {},
          evidenceIds: [],
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    async function runJob(): Promise<string | undefined> {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job: 'self.maintain' } },
      });
      const result = await executeTask(deps, task.id);
      expect(result.outcome).toBe('done');
      return result.detail;
    }

    async function backlog() {
      const rows = await store.collection('selfMaintenance').where('agentId', '==', agentId).get();
      return rows.docs
        .map((doc) => ({
          title: doc.get('title'),
          status: doc.get('status'),
          blockedReason: doc.get('blockedReason'),
        }))
        .sort((left, right) => String(left.title).localeCompare(String(right.title)));
    }

    it('fences protected targets, records each title once, and reads only open proposals', async () => {
      await proposal({ title: 'Browse crashes on empty pages' });
      await proposal({ title: 'Already handled', status: 'applied' });

      expect(await runJob()).toBe('self-maintain: 1 backlog item(s), 2 blocked by the fence');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('- [bug] Browse crashes on empty pages');
      expect(prompts[0]).not.toContain('Already handled');
      expect(await backlog()).toEqual([
        {
          title: 'Guard the empty browse result',
          status: 'backlog',
          blockedReason: null,
        },
        {
          title: 'Loosen the approval gate',
          status: 'blocked',
          blockedReason: expect.stringContaining('protected path'),
        },
        { title: 'Unplaced fix', status: 'blocked', blockedReason: 'no target file identified' },
      ]);

      // The same triage the next night adds nothing.
      expect(await runJob()).toBe('self-maintain: 0 backlog item(s), 0 blocked by the fence');
      expect(await backlog()).toHaveLength(3);
    });

    it('treats an imported item with the same title as already recorded', async () => {
      await proposal({ title: 'Browse crashes on empty pages' });
      const imported = randomUUID();
      await store.doc('selfMaintenance', imported).set(
        encodeRecord({
          id: imported,
          agentId,
          title: 'Guard the empty browse result',
          status: 'dismissed',
          proposalId: null,
          diagnosis: 'old',
          targetArea: 'packages/core/src/browse.ts',
          blockedReason: null,
          prNumber: null,
          prUrl: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      expect(await runJob()).toBe('self-maintain: 0 backlog item(s), 2 blocked by the fence');
      const rows = await backlog();
      expect(rows.find((row) => row.title === 'Guard the empty browse result')?.status).toBe(
        'dismissed',
      );
    });

    it('skips the model when nothing is open', async () => {
      await proposal({ title: 'Someone else', agent: randomUUID() });
      expect(await runJob()).toBe('self-maintain: 0 backlog item(s), 0 blocked by the fence');
      expect(prompts).toEqual([]);
    });
  },
);
