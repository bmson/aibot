import type { OwnerCommitment } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function commitment(input: Partial<OwnerCommitment> & Pick<OwnerCommitment, 'id' | 'title'>) {
  const { id, title, ...fields } = input;
  return {
    id,
    agentId: 'owner-agent',
    conversationId: 'conversation',
    sourceMessageId: null,
    sourceTaskId: null,
    kind: 'promise',
    title,
    details: '',
    nextAction: '',
    status: 'open',
    dueAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.90',
    contentHash: input.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  } satisfies OwnerCommitment;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore owner context', () => {
  let store: InstallationStore;
  let repository: FirestoreOwnerContextRepository;

  beforeEach(() => {
    store = emulatorStore(() => NOW);
    repository = new FirestoreOwnerContextRepository(store);
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('reads the agent-addressed owner card and fails closed on foreign contents', async () => {
    await store.doc('ownerCards', 'owner-agent').set({
      agentId: 'owner-agent',
      content: 'Private owner profile',
      compiledAt: NOW,
    });
    await expect(repository.getOwnerCard('owner-agent')).resolves.toEqual({
      content: 'Private owner profile',
      compiledAt: NOW,
    });
    await expect(repository.getOwnerCard('foreign-agent')).resolves.toBeNull();

    await store.doc('ownerCards', 'owner-agent').set({
      agentId: 'foreign-agent',
      content: 'Foreign profile in a corrupted path',
      compiledAt: NOW,
    });
    await expect(repository.getOwnerCard('owner-agent')).resolves.toBeNull();
  });

  it('returns only the newest location inside the requested retention and source scope', async () => {
    const rows = [
      {
        id: 'old',
        agentId: 'owner-agent',
        lat: '1.000000',
        lng: '1.000000',
        label: 'Old',
        accuracyM: 10,
        source: 'ios-app',
        timeZone: null,
        capturedAt: new Date('2026-09-12T10:00:00Z'),
        createdAt: NOW,
      },
      {
        id: 'shortcut',
        agentId: 'owner-agent',
        lat: '2.000000',
        lng: '2.000000',
        label: 'Shortcut',
        accuracyM: 10,
        source: 'shortcut',
        timeZone: null,
        capturedAt: new Date('2026-09-12T11:58:00Z'),
        createdAt: NOW,
      },
      {
        id: 'latest',
        agentId: 'owner-agent',
        lat: '3.000000',
        lng: '3.000000',
        label: 'Latest',
        accuracyM: 10,
        source: 'ios-app',
        timeZone: null,
        capturedAt: new Date('2026-09-12T11:59:00Z'),
        createdAt: NOW,
      },
      {
        id: 'foreign',
        agentId: 'foreign-agent',
        lat: '4.000000',
        lng: '4.000000',
        label: 'Foreign',
        accuracyM: 10,
        source: 'ios-app',
        timeZone: null,
        capturedAt: NOW,
        createdAt: NOW,
      },
    ];
    await Promise.all(rows.map((row) => store.doc('locationPings', row.id).set(row)));
    const input = {
      agentId: 'owner-agent',
      notBefore: new Date('2026-09-12T11:30:00Z'),
      notAfter: NOW,
    };
    await expect(repository.getLatestLocation(input)).resolves.toMatchObject({ id: 'latest' });
    await expect(
      repository.getLatestLocation({ ...input, source: 'shortcut' }),
    ).resolves.toMatchObject({ id: 'shortcut' });
    await expect(
      repository.getLatestLocation({
        ...input,
        notBefore: new Date('2026-09-12T11:59:30Z'),
      }),
    ).resolves.toBeNull();
  });

  it('returns open and elapsed snoozes in updated order within agent scope', async () => {
    const futureSnoozes = Array.from({ length: 101 }, (_, index) =>
      commitment({
        id: `sleeping-${index}`,
        title: `Future snooze ${index}`,
        status: 'snoozed',
        snoozedUntil: new Date('2026-09-13T10:00:00Z'),
        updatedAt: new Date(NOW.getTime() - index * 1000),
      }),
    );
    const rows = [
      commitment({
        id: 'older-open',
        title: 'Older open',
        updatedAt: new Date('2026-09-12T09:00:00Z'),
      }),
      commitment({
        id: 'newer-open',
        title: 'Newer open',
        updatedAt: new Date('2026-09-12T11:00:00Z'),
      }),
      commitment({
        id: 'elapsed',
        title: 'Elapsed snooze',
        status: 'snoozed',
        snoozedUntil: new Date('2026-09-12T10:00:00Z'),
        updatedAt: new Date('2026-09-12T10:30:00Z'),
      }),
      ...futureSnoozes,
      commitment({ id: 'resolved', title: 'Resolved', status: 'resolved' }),
      commitment({ id: 'foreign', title: 'Foreign', agentId: 'foreign-agent' }),
    ];
    const batch = store.db.batch();
    for (const row of rows) batch.set(store.doc('commitments', row.id), row);
    await batch.commit();
    const found = await repository.listOpenCommitments({
      agentId: 'owner-agent',
      now: NOW,
      limit: 3,
    });
    expect(found.map((row) => row.id)).toEqual(['newer-open', 'elapsed', 'older-open']);
  });

  it('rejects a commitment whose stored identity does not match its document path', async () => {
    await store
      .doc('commitments', 'document-id')
      .set(commitment({ id: 'different-id', title: 'Corrupted identity' }));
    await expect(
      repository.listOpenCommitments({ agentId: 'owner-agent', now: NOW, limit: 5 }),
    ).resolves.toEqual([]);
  });
});
