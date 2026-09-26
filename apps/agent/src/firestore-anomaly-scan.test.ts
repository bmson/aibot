import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const SPACE = { provider: 'synthetic', model: 'anomaly-fixture', dimensions: 1536, revision: '1' };
const MINUTE = 60_000;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore approval anomaly scan',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: ExecutorDeps;
    const now = new Date();

    /** The latest top of an hour in 00:00–05:00 UTC whose burst window has already passed. */
    function lastOffHour(): Date {
      const hour = new Date(now);
      hour.setUTCMinutes(0, 0, 0);
      while (hour.getUTCHours() > 5 || hour.getTime() + 10 * MINUTE > now.getTime())
        hour.setTime(hour.getTime() - 60 * MINUTE);
      return hour;
    }

    beforeEach(async () => {
      store = emulatorStore();
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      const unavailable = (name: string) =>
        new Proxy(
          {},
          {
            get: (_target, property) => {
              throw new Error(`Unexpected ${name} access: ${String(property)}`);
            },
          },
        );
      deps = {
        db: unavailable('db') as Db,
        router: unavailable('router') as ExecutorDeps['router'],
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

    async function policy(toolName: string) {
      const id = randomUUID();
      await store
        .doc('approvalPolicies', id)
        .set(
          encodeRecord({ id, agentId, toolName, enabled: true, createdAt: now, updatedAt: now }),
        );
      return id;
    }

    async function autoRun(
      toolName: string,
      policyId: string | null,
      at: Date,
      status = 'succeeded',
    ) {
      const id = randomUUID();
      await store.doc('toolCalls', id).set(
        encodeRecord({
          id,
          taskId: randomUUID(),
          toolName,
          risk: 'autonomous',
          status,
          decision: policyId ? { policyId } : {},
          createdAt: at,
        }),
      );
      return id;
    }

    async function runJob() {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job: 'anomaly.scan' } },
      });
      const result = await executeTask(deps, task.id);
      expect(result.outcome).toBe('done');
      return result.detail;
    }

    it('flags a burst and off-hours sends once, and leaves unrelated calls alone', async () => {
      const send = await policy('gmail.send');
      const lookup = await policy('weather.lookup');
      // A burst of six overnight sends — a burst, a frequency spike and off-hours at once.
      const night = lastOffHour();
      for (let i = 0; i < 6; i++)
        await autoRun('gmail.send', send, new Date(night.getTime() + i * MINUTE));
      // Calls outside any owner policy or not auto-executed are ignored.
      await autoRun('gmail.send', randomUUID(), new Date(now.getTime() - 5 * MINUTE));
      await autoRun('gmail.send', send, new Date(now.getTime() - 5 * MINUTE), 'failed');
      await autoRun('weather.lookup', lookup, new Date(now.getTime() - 5 * MINUTE));

      expect(await runJob()).toBe(
        'anomaly scan: 3 new anomalies (1 burst, 1 frequency, 1 off_hours)',
      );
      const rows = await store.collection('anomalies').get();
      const kinds = rows.docs.map((doc) => [
        doc.get('kind'),
        doc.get('observed'),
        doc.get('status'),
      ]);
      expect(kinds.sort()).toEqual([
        ['burst', 6, 'open'],
        ['frequency', 6, 'open'],
        ['off_hours', 6, 'open'],
      ]);

      // A re-scan never double-reports the same windows.
      expect(await runJob()).toBe('anomaly scan: 0 new anomalies');
      const marker = await store.doc('notificationConversations', agentId).get();
      const notices = await store
        .collection('messages')
        .where('conversationId', '==', marker.get('conversationId'))
        .get();
      expect(notices.docs.map((doc) => doc.get('text'))).toEqual([
        expect.stringContaining('3 approval anomalies detected'),
      ]);
      expect(notices.docs[0]?.get('text')).not.toContain('weather.lookup');
    });

    it('treats a dismissed frequency observation as the new floor', async () => {
      // Six spread-out lookups: above the default frequency threshold of five, but
      // not a burst, and not outward-facing so off-hours never applies.
      const lookup = await policy('weather.lookup');
      for (let i = 0; i < 6; i++)
        await autoRun('weather.lookup', lookup, new Date(now.getTime() - (20 + i * 30) * MINUTE));
      const dismissed = randomUUID();
      await store.doc('anomalies', dismissed).set(
        encodeRecord({
          id: dismissed,
          agentId,
          kind: 'frequency',
          status: 'dismissed',
          policyId: lookup,
          toolName: 'weather.lookup',
          observed: 8,
          expected: 5,
          toolCallIds: [],
          detail: 'old',
          windowLabel: '2026-09-20',
          subjectKey: lookup,
          createdAt: now,
          updatedAt: now,
        }),
      );
      expect(await runJob()).toBe('anomaly scan: 0 new anomalies');
    });
  },
);
