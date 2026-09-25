import { randomUUID } from 'node:crypto';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import type { Db } from '@assistant/db';
import {
  embeddingSpaceKey,
  FirestoreContactLookupRepository,
  FirestoreConversationSearchRepository,
  FirestoreGraphRecallRepository,
  FirestoreMemoryRepository,
  FirestoreOccasionToolRepository,
  FirestoreSituationToolRepository,
  FirestoreToolExecutionRepository,
} from '@assistant/firestore';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import {
  registerPortableContactLookupTool,
  registerPortableConversationSearchTool,
  registerPortableGraphSnapshotTool,
  registerPortableOccasionTools,
  registerPortableReadResultTool,
  registerSituationTools,
} from '@assistant/tools/builtin';
import { ToolRegistry } from '@assistant/tools/registry';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const AGENT = 'owner-agent';
const now = new Date('2026-09-25T12:00:00.000Z');
const earlier = new Date('2026-09-20T12:00:00.000Z');
const space: EmbeddingSpace = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  revision: '1',
};
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore built-in record tools without PostgreSQL',
  () => {
    let store: InstallationStore;
    let sqlAccesses: string[];
    let registry: ToolRegistry;

    function context(overrides: { taskId?: string; trust?: string; agentId?: string } = {}) {
      return {
        taskId: overrides.taskId ?? 'task',
        agentId: overrides.agentId ?? AGENT,
        trust: overrides.trust ?? 'owner',
        tainted: false,
        db: new Proxy(
          {},
          {
            get: (_target, property) => {
              sqlAccesses.push(String(property));
              throw new Error(`Unexpected SQL access: ${String(property)}`);
            },
          },
        ) as Db,
        now: () => now,
        signal: new AbortController().signal,
        log: async () => {},
      } as never;
    }

    async function run(
      name: string,
      args: Record<string, unknown>,
      ctx: Parameters<typeof context>[0] = {},
    ) {
      const tool = registry.get(name)?.tool;
      if (!tool) throw new Error(`${name} was not registered`);
      return tool.execute(tool.inputSchema.parse(args), context(ctx)) as Promise<
        Record<string, unknown>
      >;
    }

    beforeEach(async () => {
      store = emulatorStore(() => now);
      sqlAccesses = [];
      const embed = async (texts: string[]) => texts.map(() => vector);
      registry = new ToolRegistry();
      registerPortableGraphSnapshotTool(registry, {
        embed,
        graph: new FirestoreGraphRecallRepository(store, space),
      });
      registerPortableReadResultTool(registry, {
        toolExecution: new FirestoreToolExecutionRepository(store),
      });
      registerPortableOccasionTools(registry, new FirestoreOccasionToolRepository(store, AGENT));
      registerPortableContactLookupTool(
        registry,
        new FirestoreContactLookupRepository(store, AGENT),
      );
      registerPortableConversationSearchTool(registry, {
        embed,
        conversations: new FirestoreConversationSearchRepository(store, space),
      });
      registerSituationTools(registry, new FirestoreSituationToolRepository(store, AGENT));
      await store.doc('agents', AGENT).set({ id: AGENT, name: 'Owner', timezone: 'UTC' });
    });

    afterEach(async () => {
      expect(sqlAccesses).toEqual([]);
      await disposeStore(store);
    });

    async function contact(
      id: string,
      fields: Partial<Records['contacts']> & { agentId?: string },
    ) {
      await store.doc('contacts', id).set({
        id,
        name: id,
        createdAt: earlier,
        updatedAt: earlier,
        trust: 'known',
        aliases: [],
        emails: [],
        phones: [],
        relationship: '',
        notes: '',
        ...fields,
      });
    }

    async function graphFact(id: string, options: { space?: EmbeddingSpace } = {}) {
      const memory: Records['memories'] = {
        id,
        agentId: AGENT,
        content: `Anna works at ${id}`,
        contentHash: `hash-${id}`,
        createdAt: earlier,
        expiresAt: null,
        embedding: vector,
        sourceTaskId: null,
        kind: 'fact',
        confidence: '0.90',
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        importance: 3,
        quarantined: false,
        subjectContactId: null,
        domain: null,
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: false,
        source: 'chat',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      };
      await new FirestoreMemoryRepository(store, options.space ?? space).save(memory);
      await store.doc('knowledgeGraphEntities', `anna-${id}`).set({
        id: `anna-${id}`,
        agentId: AGENT,
        kind: 'person',
        label: 'anna',
        preferredLabel: 'Anna',
      });
      await store.doc('knowledgeGraphEntities', `org-${id}`).set({
        id: `org-${id}`,
        agentId: AGENT,
        kind: 'organization',
        label: id,
        preferredLabel: null,
      });
      await store.doc('knowledgeGraphSources', id).set({
        memoryId: id,
        status: 'ready',
        contentHash: memory.contentHash,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      });
      await store.doc('knowledgeGraphRelations', `relation-${id}`).set({
        id: `relation-${id}`,
        agentId: AGENT,
        sourceMemoryId: id,
        subjectEntityId: `anna-${id}`,
        objectEntityId: `org-${id}`,
        predicate: 'works_at',
        evidenceQuote: `works at ${id}`,
        confidence: '0.80',
        reviewStatus: 'pending',
        validFrom: null,
        validUntil: null,
        createdAt: earlier,
      });
    }

    it('reads a source-backed graph snapshot in the configured embedding space', async () => {
      await graphFact('acme');
      await graphFact('elsewhere', { space: { ...space, revision: '2' } });
      const result = await run('memory.graph_snapshot', { query: 'where does Anna work' });
      expect(result.complete).toBe(true);
      expect(result.relationships).toEqual([
        expect.objectContaining({
          id: 'relation-acme',
          subjectLabel: 'Anna',
          subjectKind: 'person',
          predicate: 'works_at',
          objectLabel: 'acme',
          objectKind: 'organization',
          sourceMemoryId: 'acme',
          sourceMemory: 'Anna works at acme',
          source: 'chat',
          evidenceQuote: 'works at acme',
          relationshipConfidence: '0.80',
          unconfirmed: false,
        }),
      ]);
    });

    it('pages a stored result only for the calling task and owner', async () => {
      const taskId = randomUUID();
      const otherTaskId = randomUUID();
      const callId = randomUUID();
      const otherCallId = randomUUID();
      await store.doc('tasks', taskId).set({ id: taskId, agentId: AGENT, status: 'running' });
      await store.doc('tasks', otherTaskId).set({ id: otherTaskId, agentId: AGENT });
      const result = { text: 'x'.repeat(40_000) };
      for (const [id, task] of [
        [callId, taskId],
        [otherCallId, otherTaskId],
      ] as const)
        await store.doc('toolCalls', id).set({
          id,
          taskId: task,
          toolName: 'web.fetch',
          status: 'succeeded',
          approvalId: null,
          result,
        });

      const first = await run('tools.read_result', { toolCallId: callId }, { taskId });
      expect(first).toMatchObject({ offset: 0, hasMore: true });
      expect(first.totalChars).toBe(JSON.stringify(result).length);
      expect(String(first.chunk)).toHaveLength(30_000);
      const rest = await run(
        'tools.read_result',
        { toolCallId: callId, offset: 30_000 },
        { taskId },
      );
      expect(rest.hasMore).toBe(false);
      expect(await run('tools.read_result', { toolCallId: otherCallId }, { taskId })).toEqual({
        error: 'no such tool call in this task',
      });
      expect(
        await run('tools.read_result', { toolCallId: callId }, { taskId, agentId: 'foreign' }),
      ).toEqual({ error: 'no such tool call in this task' });
    });

    it('saves occasions with tool provenance and lists only reviewed upcoming dates', async () => {
      await contact('owner-contact', { name: 'Olivia Owner', trust: 'owner' });
      await contact('anna', { name: 'Anna Jónsdóttir' });

      expect(
        await run('occasions.save', {
          subject: 'Anna',
          kind: 'birthday',
          month: 10,
          day: 1,
          notes: 'Likes tea',
        }),
      ).toEqual({ saved: true, updated: false, quarantined: false, person: 'Anna' });
      expect(
        await run('occasions.save', {
          subject: 'anna jónsdóttir',
          kind: 'birthday',
          month: 10,
          day: 1,
          year: 1990,
          notes: 'Books',
        }),
      ).toEqual({ saved: false, updated: true, quarantined: false, person: 'anna jónsdóttir' });
      expect(
        await run(
          'occasions.save',
          { subject: 'Bob Stranger', kind: 'anniversary', month: 9, day: 27 },
          { trust: 'unknown' },
        ),
      ).toEqual({ saved: true, updated: false, quarantined: true, person: 'Bob Stranger' });
      expect(
        await run('occasions.save', { subject: 'assistant', kind: 'birthday', month: 1, day: 1 }),
      ).toEqual({ saved: false, note: 'could not resolve who this occasion is about' });

      const rows = (await store.collection('occasions').get()).docs.map((doc) => doc.data());
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.contactId === 'anna')).toMatchObject({
        agentId: AGENT,
        notes: 'Likes tea; Books',
        year: 1990,
        originTrust: 'owner',
        quarantined: false,
        ownerConfirmed: false,
        source: 'occasions.save',
      });
      expect(rows.find((row) => row.contactId !== 'anna')).toMatchObject({
        originTrust: 'unknown',
        quarantined: true,
        ownerConfirmed: false,
      });
      const bob = (await store.collection('contacts').where('name', '==', 'Bob Stranger').get())
        .docs[0];
      expect(bob?.get('trust')).toBe('unknown');

      await store.doc('occasions', 'foreign').set({
        id: 'foreign',
        agentId: 'foreign',
        contactId: 'anna',
        kind: 'birthday',
        label: '',
        month: 9,
        day: 26,
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        notes: '',
        quarantined: false,
      });
      expect(await run('occasions.list', { withinDays: 30 })).toEqual({
        occasions: [
          {
            person: 'Anna Jónsdóttir',
            kind: 'birthday',
            date: '2026-10-01',
            daysUntil: 6,
            notes: 'Likes tea; Books',
          },
        ],
      });
      expect(await run('occasions.list', { withinDays: 3 })).toEqual({ occasions: [] });
      await expect(
        run('occasions.list', { withinDays: 30 }, { agentId: 'foreign' }),
      ).rejects.toThrow('outside the configured Firestore agent');
    });

    it('looks up saved addresses by name and alias without creating contacts', async () => {
      await contact('anna', {
        name: 'Anna Jónsdóttir',
        aliases: ['Annie'],
        emails: ['anna@example.com', 'not an email'],
        phones: ['+1 555 0100'],
        relationship: 'sister',
      });
      await contact('foreign', { name: 'Anna Foreign', agentId: 'foreign', emails: ['x@y.z'] });
      const expected = {
        query: 'Anna',
        contacts: [
          {
            name: 'Anna Jónsdóttir',
            emails: ['anna@example.com'],
            phones: ['+1 555 0100'],
            relationship: 'sister',
          },
        ],
      };
      expect(await run('contacts.lookup', { name: 'Anna' })).toEqual(expected);
      expect(await run('contacts.lookup', { name: 'Annie' })).toEqual({
        ...expected,
        query: 'Annie',
      });
      expect(await run('contacts.lookup', { name: 'Nobody' })).toEqual({
        query: 'Nobody',
        contacts: [],
      });
      expect((await store.collection('contacts').get()).size).toBe(2);
    });

    async function conversation(id: string, agentId = AGENT) {
      await store.doc('conversations', id).set({ id, agentId, trust: 'owner' });
    }
    async function message(
      id: string,
      conversationId: string,
      text: string,
      options: { embedded?: boolean; revision?: string; createdAt?: Date } = {},
    ) {
      await store.doc('messages', id).set({
        id,
        conversationId,
        role: 'user',
        text,
        createdAt: options.createdAt ?? earlier,
        ...(options.embedded === false
          ? { embedding: null }
          : {
              embedding: FieldValue.vector(vector),
              embeddingSpace: embeddingSpaceKey({ ...space, revision: options.revision ?? '1' }),
            }),
      });
    }

    it('searches owned conversations in the configured embedding space', async () => {
      await conversation('mine');
      await conversation('theirs', 'foreign');
      await message('owned', 'mine', 'We discussed the kitchen remodel');
      await message('foreign', 'theirs', 'Foreign kitchen remodel');
      await message('old-space', 'mine', 'Old kitchen vectors', { revision: '2' });
      const result = await run('conversations.search', { query: 'kitchen', limit: 5 });
      expect(result.mode).toBe('semantic');
      expect(result.matches).toEqual([
        expect.objectContaining({
          conversationId: 'mine',
          text: 'We discussed the kitchen remodel',
          createdAt: earlier,
        }),
      ]);

      // A full candidate page with too few owned matches fails instead of truncating.
      for (const id of ['f1', 'f2', 'f3']) await message(id, 'theirs', 'Foreign');
      await store.doc('conversations', 'mine').update({ agentId: 'foreign' });
      await expect(run('conversations.search', { query: 'kitchen', limit: 1 })).rejects.toThrow(
        'Conversation search candidate bound reached',
      );
    });

    it('falls back to an owned substring search when nothing is embedded', async () => {
      await conversation('mine');
      await conversation('theirs', 'foreign');
      await message('a', 'mine', 'The Kitchen tiles arrived', { embedded: false });
      await message('b', 'mine', 'kitchen quote', { embedded: false, createdAt: now });
      await message('c', 'theirs', 'kitchen secret', { embedded: false, createdAt: now });
      await message('d', 'mine', 'Unrelated', { embedded: false });
      const result = await run('conversations.search', { query: 'KITCHEN', limit: 5 });
      expect(result).toEqual({
        mode: 'text',
        matches: [
          { conversationId: 'mine', text: 'kitchen quote', createdAt: now },
          { conversationId: 'mine', text: 'The Kitchen tiles arrived', createdAt: earlier },
        ],
      });
    });

    it('reads, sources, and changes owner situation packs through the pack repositories', async () => {
      const commitmentId = randomUUID();
      await store.doc('commitments', commitmentId).set({
        id: commitmentId,
        agentId: AGENT,
        title: 'Hotel reply',
        status: 'open',
        kind: 'waiting_on',
        details: '',
        nextAction: '',
        dueAt: null,
        resolution: null,
        updatedAt: earlier,
      });
      const created = await run('situations.change', {
        action: 'create',
        title: 'Lisbon trip',
        creationKey: 'lisbon',
      });
      expect(created).toMatchObject({ ok: true });
      const packId = String(created.packId);
      expect(
        await run('situations.change', { action: 'create', title: 'Again', creationKey: 'lisbon' }),
      ).toEqual({ ok: true, packId });

      expect(await run('situations.sources', {})).toEqual({
        sources: [
          { kind: 'commitment', id: commitmentId, title: 'Hotel reply', lane: 'waiting_on' },
        ],
      });
      expect(
        await run('situations.change', {
          action: 'item',
          packId,
          version: 1,
          item: {
            id: 'hotel',
            title: 'Hotel',
            lane: 'waiting_on',
            source: { kind: 'commitment', id: commitmentId },
          },
        }),
      ).toEqual({ ok: true, packId });
      expect(
        await run('situations.change', {
          action: 'decision',
          packId,
          version: 2,
          decision: {
            id: 'no_hostel',
            option: 'Hostel Central',
            outcome: 'rejected',
            reason: 'Too noisy',
            scope: 'preference',
          },
        }),
      ).toEqual({
        ok: false,
        error:
          'A lasting preference needs explicit confirmation in the pack. Save it as a situation decision first.',
      });

      const read = (await run('situations.read', { packId })) as {
        pack: { title: string; version: number; data: { items: Array<{ id: string }> } };
      };
      expect(read.pack).toMatchObject({ title: 'Lisbon trip', version: 2 });
      expect(read.pack.data.items.map((item) => item.id)).toEqual(['hotel']);
      expect(((await run('situations.read', {})) as { packs: unknown[] }).packs).toHaveLength(1);
      expect(await run('situations.read', { packId: randomUUID() })).toEqual({ pack: null });

      // Owner-confirmed decisions (from the owner UI) are what the tool recalls.
      await store.doc('situationPacks', packId).update({
        'data.decisions': [
          {
            id: 'no_hostel',
            option: 'Hostel Central',
            outcome: 'rejected',
            reason: 'Too noisy at night',
            scope: 'situation',
            confirmed: true,
          },
        ],
      });
      expect(await run('situations.decisions', { query: 'noisy hotels', packId })).toEqual({
        decisions: [
          {
            id: 'no_hostel',
            option: 'Hostel Central',
            outcome: 'rejected',
            reason: 'Too noisy at night',
            scope: 'situation',
            confirmed: true,
            packId,
            packTitle: 'Lisbon trip',
          },
        ],
      });
      // Without the pack, a situation-scoped choice is not a lasting preference.
      expect(await run('situations.decisions', { query: 'noisy hotels' })).toEqual({
        decisions: [],
      });
      await expect(run('situations.read', {}, { agentId: 'foreign' })).rejects.toThrow(
        'outside the configured Firestore agent',
      );
    });
  },
);
