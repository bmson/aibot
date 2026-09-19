import type { ManagedMemory, MemoryMutation } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  createProfileMemoryCommands,
  type ProfileMemoryCommandPersistence,
} from './memory-commands.js';

const memory: ManagedMemory = { id: 'fact', agentId: 'owner', contentHash: 'before' };
const updated: MemoryMutation = { status: 'updated', memory };

function fixture() {
  const events: string[] = [];
  const mutate = vi.fn(async (): Promise<MemoryMutation> => {
    events.push('mutate');
    return updated;
  });
  const persistence: ProfileMemoryCommandPersistence = {
    kind: 'profile-memory-command-persistence',
    memories: {
      kind: 'profile-memory-management-repository',
      get: vi.fn(async () => memory),
      confirm: mutate,
      restore: mutate,
      correct: mutate,
      forget: mutate,
      setProminence: mutate,
      approveQuarantined: mutate,
      create: mutate,
    },
    ownerCards: {
      kind: 'owner-card-compilation-repository',
      compile: vi.fn(async () => {
        events.push('compile');
        return '';
      }),
    },
    maintenance: {
      kind: 'profile-memory-maintenance',
      queueGraphSync: vi.fn(async () => {
        events.push('queue');
      }),
      retryBlockedGraphSource: vi.fn(async () => {
        events.push('retry');
      }),
      removeOrphanedGraphEntities: vi.fn(async () => {
        events.push('remove');
      }),
    },
  };
  const embed = vi.fn(async () => {
    events.push('embed');
    return [[1, 0]];
  });
  return {
    events,
    persistence,
    mutate,
    embed,
    commands: createProfileMemoryCommands(persistence, { embed }),
  };
}

describe('portable profile memory commands', () => {
  it('embeds before mutation and preserves the pre-embedding hash for concurrency control', async () => {
    const f = fixture();
    expect(await f.commands.correctMemory('fact', '  revised fact  ')).toEqual({});
    expect(f.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: 'fact',
        expectedContentHash: 'before',
        content: 'revised fact',
        embedding: [1, 0],
      }),
    );
    expect(f.events).toEqual(['embed', 'mutate', 'queue', 'compile']);
  });

  it('does not mutate or enqueue anything when embedding fails', async () => {
    const f = fixture();
    f.embed.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(f.commands.correctMemory('fact', 'revised fact')).rejects.toThrow(
      'provider unavailable',
    );
    expect(f.mutate).not.toHaveBeenCalled();
    expect(f.persistence.ownerCards.compile).not.toHaveBeenCalled();
    expect(f.persistence.maintenance.queueGraphSync).not.toHaveBeenCalled();
  });

  it.each(['stale', 'duplicate', 'tombstoned', 'not-found'] as const)(
    'returns an owner-facing error and skips follow-ups for %s correction',
    async (status) => {
      const f = fixture();
      f.mutate.mockResolvedValueOnce({ status });
      expect(await f.commands.correctMemory('fact', 'revised fact')).toEqual({
        error: expect.any(String),
      });
      expect(f.persistence.ownerCards.compile).not.toHaveBeenCalled();
      expect(f.persistence.maintenance.queueGraphSync).not.toHaveBeenCalled();
    },
  );

  it('cleans graph projections before rebuilding the card after rejection', async () => {
    const f = fixture();
    await f.commands.rejectQuarantinedMemory('fact');
    expect(f.mutate).toHaveBeenCalledWith('fact', 'quarantine_reject');
    expect(f.events).toEqual(['mutate', 'remove', 'compile']);
    expect(f.persistence.maintenance.removeOrphanedGraphEntities).toHaveBeenCalledWith({
      agentId: 'owner',
      memoryId: 'fact',
    });
  });

  it('leaves the invalidated card alone when required graph cleanup fails', async () => {
    const f = fixture();
    vi.mocked(f.persistence.maintenance.removeOrphanedGraphEntities).mockRejectedValueOnce(
      new Error('cleanup unavailable'),
    );
    await expect(f.commands.forgetMemory('fact')).rejects.toThrow('cleanup unavailable');
    expect(f.mutate).toHaveBeenCalledOnce();
    expect(f.persistence.ownerCards.compile).not.toHaveBeenCalled();
  });

  it('retries quarantined graph sources and queues repair before recompiling', async () => {
    const f = fixture();
    await f.commands.approveQuarantinedMemory('fact');
    expect(f.events).toEqual(['mutate', 'retry', 'queue', 'compile']);
  });

  it('retries follow-ups for an already-approved fact after an earlier failure', async () => {
    const f = fixture();
    vi.mocked(f.persistence.maintenance.queueGraphSync).mockRejectedValueOnce(
      new Error('queue unavailable'),
    );
    await expect(f.commands.approveQuarantinedMemory('fact')).rejects.toThrow('queue unavailable');
    await f.commands.approveQuarantinedMemory('fact');
    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.persistence.maintenance.retryBlockedGraphSource).toHaveBeenCalledTimes(2);
    expect(f.persistence.maintenance.queueGraphSync).toHaveBeenCalledTimes(2);
    expect(f.persistence.ownerCards.compile).toHaveBeenCalledTimes(1);
  });

  it('rebuilds an invalidated card when a persisted create is retried as a duplicate', async () => {
    const f = fixture();
    const input = {
      content: 'new fact',
      domain: 'other',
      importance: '3',
      pinned: false,
      subjectContactId: '11111111-1111-4111-8111-111111111111',
    };
    vi.mocked(f.persistence.ownerCards.compile).mockRejectedValueOnce(
      new Error('compile unavailable'),
    );
    await expect(f.commands.createMemory(input)).rejects.toThrow('compile unavailable');
    f.mutate.mockResolvedValueOnce({ status: 'duplicate', memory });
    expect(await f.commands.createMemory(input)).toEqual({ error: 'That fact is already saved.' });
    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.persistence.ownerCards.compile).toHaveBeenCalledTimes(2);
  });

  it('validates creation without an embedding call and maps missing subjects distinctly', async () => {
    const f = fixture();
    const input = {
      content: 'new fact',
      domain: 'other',
      importance: '3',
      pinned: false,
      subjectContactId: 'invalid',
    };
    expect(await f.commands.createMemory(input)).toEqual({ error: 'Invalid subject.' });
    expect(f.embed).not.toHaveBeenCalled();
    f.mutate.mockResolvedValueOnce({ status: 'not-found' });
    expect(
      await f.commands.createMemory({
        ...input,
        subjectContactId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({ error: 'Invalid subject.' });
    expect(f.persistence.ownerCards.compile).not.toHaveBeenCalled();
  });
});
