import { randomUUID } from 'node:crypto';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import {
  applicationConfirmationTaskHandlers,
  applicationPersistence,
  executeApplicationConfirmationTask,
  processApplicationConfirmation,
} from '@assistant/modules';
import type { ExecutionPersistence } from '@assistant/persistence';
import type { ToolContext } from '@assistant/tools';
import { type GoogleClient, registerApplicationTools, ToolRegistry } from '@assistant/tools';
import { ToolDispatcher } from '@assistant/tools/dispatcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { reapExpiredApplicationWatches } from '../../../packages/modules/src/google/application-confirmations.js';

const SPACE = { provider: 'synthetic', model: 'apps-fixture', dimensions: 1536, revision: '1' };
const SENDER = 'careers@acme.test';
const HOUR = 3_600_000;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore application confirmations', { timeout: 30_000 }, () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let persistence: ExecutionPersistence;
  let registry: ToolRegistry;
  let dispatcher: ToolDispatcher;
  let api: ReturnType<typeof vi.fn>;
  let notices: string[];
  const db = new Proxy({} as Db, {
    get: (_target, property) => {
      throw new Error(`PostgreSQL access in Firestore test: ${String(property)}`);
    },
  });

  beforeEach(async () => {
    store = emulatorStore();
    notices = [];
    persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
    api = vi.fn(async (url: string) =>
      url.includes('docs.googleapis.com') && !url.endsWith(':batchUpdate')
        ? { body: { content: [{ endIndex: 1 }] } }
        : {},
    );
    const apps = applicationPersistence(persistence);
    registry = registerApplicationTools(new ToolRegistry(), {
      client: { api, configured: () => true } as unknown as GoogleClient,
      applications: apps.applications,
      tasks: persistence.tasks,
    });
    dispatcher = new ToolDispatcher(
      db,
      registry,
      persistence.toolExecution,
      persistence.costs,
      persistence.approvals,
      persistence.approvalPolicies,
    );
    await store.doc('agents', agentId).set({ id: agentId, name: 'Ada', timezone: 'UTC' });
    await store.doc('coordination', 'budget-policy').set({
      dailyLimitMicros: 1_000_000,
      monthlyLimitMicros: 10_000_000,
      softPct: 80,
    });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  const deps = () => ({
    db,
    dispatcher,
    persistence: applicationPersistence(persistence),
    notifyOwner: async (input: { text: string }) => {
      notices.push(input.text);
    },
  });

  async function ownerTask() {
    const { task } = await persistence.tasks.createTask({
      agentId,
      type: 'adhoc',
      trust: 'owner',
      trigger: { source: 'owner', payload: { instruction: 'apply to acme' } },
    });
    return task;
  }

  function ctx(taskId: string, conversationId?: string): ToolContext {
    return {
      taskId,
      agentId,
      conversationId,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    };
  }

  async function watch(token: string, extra: Record<string, unknown> = {}) {
    const tool = registry.get('applications.watch_confirmation')?.tool;
    if (!tool) throw new Error('missing watch tool');
    const task = await ownerTask();
    return tool.execute(
      {
        company: 'Acme',
        role: 'Engineer',
        expectedSenderEmails: [SENDER],
        confirmationToken: token,
        expiresAt: new Date(Date.now() + 48 * HOUR).toISOString(),
        trackerUpdate: {
          spreadsheetId: 'sheet-1234567890',
          sheetName: 'Applications',
          startCell: 'A2',
          rows: [['Acme', 'Engineer', 'confirmed']],
        },
        documentUpdate: { documentId: 'doc-1234567890', content: 'Acme confirmed receipt.' },
        ...extra,
      },
      ctx(task.id),
    ) as Promise<{ applicationId: string; conversationId: string; status: string }>;
  }

  const email = (messageId: string, body: string, from = SENDER) =>
    processApplicationConfirmation(deps(), {
      agentId,
      messageId,
      from,
      subject: 'Application received',
      body,
      authenticated: true,
    });

  it('creates one active watch per token, in a new follow-up chat', async () => {
    const created = await watch('REQ-100200');
    expect(created.status).toBe('awaiting_confirmation');
    const chat = await store.doc('conversations', created.conversationId).get();
    expect([chat.get('channel'), chat.get('trust'), chat.get('title')]).toEqual([
      'chat',
      'owner',
      'Acme — Engineer',
    ]);
    await expect(watch('req-100200')).rejects.toThrow(
      'an active confirmation watch already uses this token',
    );
    const raced = await Promise.allSettled([watch('REQ-300400'), watch('REQ-300400')]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const list = registry.get('applications.list_confirmations')?.tool;
    const listed = (await list?.execute({}, ctx((await ownerTask()).id))) as {
      confirmations: Array<{ tokenHint: string }>;
    };
    expect(listed.confirmations.map((row) => row.tokenHint).sort()).toEqual(['0200', '0400']);
  });

  it('claims the matching email once and runs both pre-authorized updates through the dispatcher', async () => {
    const created = await watch('REQ-100200');
    expect(await email('m-unrelated', 'Thanks for applying!')).toEqual({ kind: 'ignored' });
    expect(await email('m-other-sender', 'Ref REQ-100200', 'spoof@else.test')).toEqual({
      kind: 'ignored',
    });

    const claimed = await email('m-1', 'Your reference is REQ-100­200.');
    expect(claimed).toEqual({ kind: 'in_progress', applicationId: created.applicationId });
    const [task] = (
      await store
        .collection('tasks')
        .where('externalEventId', '==', 'application-confirmation:gmail:m-1')
        .get()
    ).docs;
    if (!task) throw new Error('missing confirmation task');

    const handler = applicationConfirmationTaskHandlers.find(
      (h) => h.kind === 'application_confirmation',
    );
    expect(handler).toBeDefined();
    expect(await executeApplicationConfirmationTask(deps(), task.get('id'))).toEqual({
      outcome: 'done',
      applicationId: created.applicationId,
    });
    const record = await persistence.applications?.get(created.applicationId);
    expect([record?.status, record?.actionState]).toEqual([
      'updated',
      { sheet: { status: 'succeeded' }, document: { status: 'succeeded' } },
    ]);
    expect(api.mock.calls.map(([url]) => String(url).split('?')[0])).toEqual([
      expect.stringContaining('sheets.googleapis.com/v4/spreadsheets/sheet-1234567890/values/'),
      'https://docs.googleapis.com/v1/documents/doc-1234567890',
      'https://docs.googleapis.com/v1/documents/doc-1234567890:batchUpdate',
    ]);
    expect(notices).toEqual([
      expect.stringContaining('I matched the authenticated confirmation for Acme'),
    ]);

    // A replayed email and a replayed task change nothing.
    expect(await email('m-1', 'Your reference is REQ-100200.')).toMatchObject({ kind: 'replay' });
    expect(await executeApplicationConfirmationTask(deps(), task.get('id'))).toMatchObject({
      outcome: 'done',
    });
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('changes nothing when one email matches two watches', async () => {
    await watch('REQ-111111');
    await watch('REQ-222222');
    expect(await email('m-2', 'Refs REQ-111111 and REQ-222222')).toMatchObject({
      kind: 'ambiguous',
    });
    const [task] = (
      await store
        .collection('tasks')
        .where('externalEventId', '==', 'application-confirmation:gmail:m-2:ambiguous')
        .get()
    ).docs;
    expect(task?.get('status')).toBe('needs_attention');
    expect(api).not.toHaveBeenCalled();
    expect(notices).toEqual([expect.stringContaining('matched 2 application watches')]);
  });

  it('cancels a waiting watch and reaps an expired one with a notice', async () => {
    const cancelled = await watch('REQ-555555');
    const cancel = registry.get('applications.cancel_confirmation')?.tool;
    const task = await ownerTask();
    expect(await cancel?.execute({ applicationId: cancelled.applicationId }, ctx(task.id))).toEqual(
      {
        applicationId: cancelled.applicationId,
        status: 'cancelled',
        cancelled: true,
      },
    );
    expect(
      await cancel?.execute({ applicationId: cancelled.applicationId }, ctx(task.id)),
    ).toMatchObject({
      cancelled: false,
      status: 'cancelled',
    });

    const expiring = await watch('REQ-666666');
    await store
      .doc('applicationConfirmations', expiring.applicationId)
      .update({ expiresAt: new Date(Date.now() - HOUR) });
    expect(await reapExpiredApplicationWatches(deps())).toBe(1);
    expect(await reapExpiredApplicationWatches(deps())).toBe(0);
    expect((await persistence.applications?.get(expiring.applicationId))?.status).toBe('expired');
    const messages = await store
      .collection('messages')
      .where('conversationId', '==', expiring.conversationId)
      .get();
    expect(messages.docs.map((doc) => doc.get('text'))).toEqual([
      expect.stringContaining('it never arrived. I made no Sheet or Doc update.'),
    ]);
  });
});
