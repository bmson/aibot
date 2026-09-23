import { expect, it } from 'vitest';
import { FirestoreShellStatusRepository } from './shell-status.js';
import { documentKey, type InstallationStore } from './store.js';

type Row = Record<string, unknown>;
type Entry = { id: string; row: Row };

class FakeDocument {
  readonly exists: boolean;

  constructor(
    readonly id: string,
    private readonly row?: Row,
  ) {
    this.exists = row !== undefined;
  }

  get(field: string): unknown {
    return this.row?.[field];
  }

  data(): Row {
    return this.row ?? {};
  }
}

class FakeQuery {
  constructor(
    private readonly rows: Entry[],
    private readonly stats: { largestPage: number; pages: number },
    private readonly filters: Array<[string, unknown]> = [],
    private readonly pageSize = Number.MAX_SAFE_INTEGER,
    private readonly cursor?: string,
  ) {}

  where(field: string, _operator: string, value: unknown): FakeQuery {
    return new FakeQuery(this.rows, this.stats, [...this.filters, [field, value]], this.pageSize);
  }

  orderBy(): FakeQuery {
    return new FakeQuery(this.rows, this.stats, this.filters, this.pageSize, this.cursor);
  }

  limit(size: number): FakeQuery {
    this.stats.largestPage = Math.max(this.stats.largestPage, size);
    return new FakeQuery(this.rows, this.stats, this.filters, size, this.cursor);
  }

  startAfter(cursor: FakeDocument): FakeQuery {
    return new FakeQuery(this.rows, this.stats, this.filters, this.pageSize, cursor.id);
  }

  async get(): Promise<{ size: number; docs: FakeDocument[] }> {
    this.stats.pages += 1;
    const matching = this.rows
      .filter(({ row }) => this.filters.every(([field, value]) => row[field] === value))
      .sort((left, right) => left.id.localeCompare(right.id));
    const after = this.cursor ? matching.findIndex((entry) => entry.id === this.cursor) + 1 : 0;
    const docs = matching
      .slice(after, after + this.pageSize)
      .map(({ id, row }) => new FakeDocument(id, row));
    return { size: docs.length, docs };
  }
}

function entries(rows: Row[]): Entry[] {
  return rows.map((row) => ({ id: documentKey(String(row.id)), row }));
}

it('pages imported-size source collections and preserves exact shell counts', async () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const taskRows = Array.from({ length: 12_945 }, (_, index) => ({
    id: `task-${String(index).padStart(5, '0')}`,
    agentId: 'owner',
    status: index % 3 === 0 ? 'needs_attention' : index % 3 === 1 ? 'running' : 'done',
  }));
  const memoryRows = Array.from({ length: 4_519 }, (_, index) => ({
    id: `memory-${String(index).padStart(4, '0')}`,
    agentId: 'owner',
    category: index % 9 === 0 ? 'episode' : 'knowledge',
    quarantined: index % 7 === 0,
    expiresAt: index % 13 === 0 ? new Date(now.getTime() - 1) : null,
    ownerConfirmed: index % 2 === 0,
    lastConsolidatedAt: index % 4 === 0 ? now : null,
    content: 'large memory payload omitted from the shell projection',
  }));
  const approvalRows = [
    {
      id: 'owner-pending-a',
      taskId: taskRows[0]?.id,
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'owner-pending-b',
      taskId: taskRows[1]?.id,
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'unknown-task',
      taskId: 'missing',
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'resolved',
      taskId: taskRows[0]?.id,
      status: 'approved',
      expiresAt: new Date(now.getTime() + 60_000),
    },
  ];
  const data: Record<string, Entry[]> = {
    agents: entries([{ id: 'owner' }]),
    tasks: entries(taskRows),
    memories: entries(memoryRows),
    approvals: entries(approvalRows),
  };
  const stats = { largestPage: 0, pages: 0 };
  const store = {
    collection(name: string) {
      return new FakeQuery(data[name] ?? [], stats);
    },
    doc(collection: string, id: string) {
      const row = data[collection]?.find((entry) => entry.id === documentKey(id))?.row;
      const doc = new FakeDocument(documentKey(id), row);
      return { get: async () => doc };
    },
    now: () => now,
  } as unknown as InstallationStore;
  const repository = new FirestoreShellStatusRepository(store, 'owner');
  const unexpiredKnowledge = memoryRows.filter(
    (memory) => memory.category === 'knowledge' && (!memory.expiresAt || memory.expiresAt > now),
  );
  const usable = unexpiredKnowledge.filter((memory) => !memory.quarantined);

  await expect(repository.load('owner')).resolves.toEqual({
    dashboard: {
      pendingApprovals: 2,
      needsAttention: taskRows.filter((task) => task.status === 'needs_attention').length,
      presence: 'attention',
    },
    memoryHealth: {
      totalUsable: usable.length,
      notYetOrganized: usable.filter((memory) => !memory.lastConsolidatedAt).length,
      awaitingReview: unexpiredKnowledge.filter((memory) => memory.quarantined).length,
      ownerConfirmed: usable.filter((memory) => memory.ownerConfirmed).length,
      lastOrganizedAt: now,
    },
  });
  expect(stats.largestPage).toBe(500);
  expect(stats.pages).toBeGreaterThan(30);
});
