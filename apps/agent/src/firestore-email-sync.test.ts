import { randomUUID } from 'node:crypto';
import type { Config } from '@assistant/config';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { EmailSyncDeps } from '@assistant/modules';
import type { ExecutionPersistence } from '@assistant/persistence';
import type { GoogleClient } from '@assistant/tools/modules/google';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { syncMailboxWithDistributedLock } from '../../../packages/modules/src/google/email-sync.js';

const SPACE = { provider: 'synthetic', model: 'mail-fixture', dimensions: 1536, revision: '1' };
const BOT = 'bot@assistant.test';
const OWNER = 'ada@owner.test';
const FRIEND = 'grace@friend.test';

function vector(): number[] {
  const values = new Array(1536).fill(0);
  values[0] = 1;
  return values;
}

interface FakeMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  authenticated?: boolean;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore Gmail sync',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let historyId: number;
    let history: string[];
    let messages: Map<string, FakeMessage>;
    let scored: string[];

    beforeEach(async () => {
      store = emulatorStore();
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      historyId = 100;
      history = [];
      messages = new Map();
      scored = [];
      await store
        .doc('agents', agentId)
        .set({ id: agentId, name: 'Bot', email: BOT, timezone: 'UTC' });
      for (const [email, trust] of [
        [OWNER, 'owner'],
        [FRIEND, 'known'],
      ] as const) {
        const id = randomUUID();
        await store
          .doc('contacts', id)
          .set({ id, name: email, trust, emails: [email], aliases: [] });
      }
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

    function gmail(): GoogleClient {
      const api = vi.fn(async (url: string) => {
        if (url.endsWith('/profile')) return { historyId: String(historyId) };
        if (url.includes('/history?')) {
          const ids = history.splice(0);
          return { history: ids.map((id) => ({ messagesAdded: [{ message: { id } }] })) };
        }
        const id = url.match(/\/messages\/([^/?]+)/)?.[1] ?? '';
        const message = messages.get(id);
        if (!message) throw Object.assign(new Error('not found'), { status: 404 });
        const domain = message.from.split('@')[1];
        return {
          id: message.id,
          threadId: message.threadId,
          labelIds: ['INBOX'],
          snippet: message.body.slice(0, 40),
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: message.from },
              { name: 'Subject', value: message.subject },
              { name: 'Message-ID', value: `<${message.id}@mail>` },
              {
                name: 'Authentication-Results',
                value:
                  message.authenticated === false
                    ? 'mx.google.com; dmarc=fail header.from=spoof.test'
                    : `mx.google.com; dmarc=pass header.from=${domain}`,
              },
            ],
            body: { data: Buffer.from(message.body).toString('base64url') },
          },
        };
      });
      return { api, configured: () => true } as unknown as GoogleClient;
    }

    function deps(overrides: Partial<Config> = {}): EmailSyncDeps {
      return {
        config: {
          ASSISTANT_MODULES: ['google'],
          EMAIL_INGEST_MODE: 'direct',
          EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
          EMAIL_INGEST_NOTIFY_THRESHOLD: 5,
          EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
          PROACTIVE_CARDS_ENABLED: false,
          ...overrides,
        } as Config,
        persistence,
        router: {
          object: async (_role: string, input: { prompt: string }) => {
            scored.push(input.prompt.slice(0, 40));
            return {
              ok: true,
              object: {
                category: 'personal',
                importance: 4,
                actionable: true,
                reason: 'fixture',
                dates: [],
              },
            };
          },
          embed: async (texts: string[]) => texts.map(() => vector()),
        } as unknown as EmailSyncDeps['router'],
        workspace: {} as EmailSyncDeps['workspace'],
        googleClient: gmail(),
        notifyOwner: async () => {},
        observeInboundEmail: async () => {},
      };
    }

    function arrive(message: Omit<FakeMessage, 'threadId'> & { threadId?: string }) {
      messages.set(message.id, { threadId: `thread-${message.id}`, ...message });
      history.push(message.id);
      historyId += 1;
    }

    async function lastHistoryId() {
      return (await persistence.emailSync?.syncState(BOT))?.lastHistoryId;
    }

    it('baselines, then triages known mail once per message and advances the cursor', async () => {
      expect(await syncMailboxWithDistributedLock(deps())).toEqual({ processed: 0 });
      expect(await lastHistoryId()).toBe(100n);

      arrive({
        id: 'm1',
        threadId: 'thread-lunch',
        from: FRIEND,
        subject: 'Lunch Friday?',
        body: 'Are you free for lunch on Friday at noon?',
      });
      arrive({
        id: 'm2',
        from: 'mallory@spoof.test',
        subject: 'Wire money',
        body: 'Urgent',
        authenticated: false,
      });
      expect(await syncMailboxWithDistributedLock(deps())).toEqual({ processed: 1 });

      const [triage] = (await store.collection('tasks').where('type', '==', 'email_triage').get())
        .docs;
      expect([triage?.get('externalEventId'), triage?.get('trust')]).toEqual(['gmail:m1', 'known']);
      const binding = await store
        .collection('channelBindings')
        .where('externalId', '==', 'thread-lunch')
        .get();
      expect(binding.size).toBe(1);
      const conversation = await store
        .doc('conversations', binding.docs[0]?.get('conversationId'))
        .get();
      expect([conversation.get('channel'), conversation.get('trust')]).toEqual(['email', 'known']);
      const ingest = await store.collection('emailIngest').get();
      expect(
        ingest.docs.map((doc) => [doc.get('channelMessageId'), doc.get('importance')]),
      ).toEqual([['gmail:m1', 4]]);
      expect(await lastHistoryId()).toBe(BigInt(historyId));

      // Gmail replays m1: nothing is scored, persisted, or triaged twice.
      arrive({ ...(messages.get('m1') as FakeMessage) });
      scored.length = 0;
      expect(await syncMailboxWithDistributedLock(deps())).toEqual({ processed: 0 });
      expect(scored).toEqual([]);
      expect((await store.collection('tasks').where('type', '==', 'email_triage').get()).size).toBe(
        1,
      );
      expect(
        (await store.collection('messages').where('channelMessageId', '==', 'gmail:m1').get()).size,
      ).toBe(1);
    });

    it('learns the owner voice from their own mail and triages it at owner trust', async () => {
      await syncMailboxWithDistributedLock(deps());
      arrive({
        id: 'm-owner',
        from: OWNER,
        subject: 'Note to self',
        body: 'Remember to book the dentist next week and move the Thursday call to the afternoon slot.',
      });
      await syncMailboxWithDistributedLock(deps());
      const samples = await store.collection('writingSamples').get();
      expect(samples.docs.map((doc) => [doc.get('register'), doc.get('context')])).toEqual([
        ['email_casual', 'auto:inbound-email'],
      ]);
      const [triage] = (await store.collection('tasks').where('type', '==', 'email_triage').get())
        .docs;
      expect(triage?.get('trust')).toBe('owner');
    });

    it('forwarded mode records every verdict and marks what it triaged', async () => {
      const forwarded = deps({ EMAIL_INGEST_MODE: 'forwarded' } as Partial<Config>);
      await syncMailboxWithDistributedLock(forwarded);
      arrive({
        id: 'f1',
        from: FRIEND,
        subject: 'Invoice due',
        body: 'Invoice 42 is due on Monday.',
      });
      await syncMailboxWithDistributedLock(forwarded);
      const [row] = (await store.collection('emailIngest').get()).docs;
      expect([row?.get('channelMessageId'), row?.get('triaged')]).toEqual(['gmail:f1', true]);
      expect(await persistence.emailSync?.triagedSince(new Date(Date.now() - 3_600_000))).toBe(1);
    });

    it('lets one instance hold the mailbox lock at a time', async () => {
      const sync = persistence.emailSync;
      if (!sync) throw new Error('missing email sync repository');
      let release: () => void = () => {};
      const first = sync.withLock(
        () =>
          new Promise<string>((resolve) => {
            release = () => resolve('first');
          }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await sync.withLock(async () => 'second')).toBeNull();
      release();
      expect(await first).toEqual({ value: 'first' });
      expect(await sync.withLock(async () => 'third')).toEqual({ value: 'third' });
    });
  },
);
