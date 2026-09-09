import type { DispatchOutbox, OutboxLease, TaskQueue } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { dispatchOutbox } from './dispatch.js';

function fixture() {
  const lease: OutboxLease = {
    id: 'intent',
    taskId: 'task',
    generation: 3,
    status: 'leased',
    leaseToken: 'fence',
    attempts: 1,
    availableAt: new Date(),
    lockedUntil: new Date(Date.now() + 60_000),
  };
  const outbox = {
    due: vi.fn().mockResolvedValue(['intent']),
    claim: vi.fn().mockResolvedValue(lease),
    acknowledge: vi.fn().mockResolvedValue(true),
    retry: vi.fn().mockResolvedValue(true),
  } satisfies DispatchOutbox;
  const queue = { enqueue: vi.fn().mockResolvedValue(undefined) } satisfies TaskQueue;
  return { outbox, queue, lease };
}
describe('durable outbox dispatcher', () => {
  it('settles only after provider acceptance and treats a failed settlement as retryable', async () => {
    const { outbox, queue, lease } = fixture();
    queue.enqueue.mockImplementation(async () => {
      expect(outbox.acknowledge).not.toHaveBeenCalled();
    });
    expect(await dispatchOutbox(outbox, queue)).toMatchObject({ delivered: 1, errors: 0 });
    expect(outbox.acknowledge).toHaveBeenCalledWith(lease);
    outbox.acknowledge.mockClear().mockRejectedValueOnce(new Error('lost connection after commit'));
    expect(await dispatchOutbox(outbox, queue)).toMatchObject({ delivered: 0, retried: 1 });
    expect(outbox.retry).toHaveBeenCalledWith(lease);
    expect(queue.enqueue.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ['task', 3],
      ['task', 3],
    ]);
  });
  it('retains failed deliveries and continues the batch when another record is broken', async () => {
    const { outbox, queue } = fixture();
    outbox.due.mockResolvedValue(['broken', 'intent']);
    outbox.claim.mockRejectedValueOnce(new Error('read failed'));
    queue.enqueue.mockRejectedValue(new Error('provider unavailable'));
    expect(await dispatchOutbox(outbox, queue, { concurrency: 1 })).toEqual({
      delivered: 0,
      retried: 1,
      leaseLost: 0,
      errors: 1,
    });
    expect(outbox.acknowledge).not.toHaveBeenCalled();
  });
  it('reports an expired settlement lease without claiming successful delivery', async () => {
    const { outbox, queue } = fixture();
    outbox.acknowledge.mockResolvedValue(false);
    expect(await dispatchOutbox(outbox, queue)).toMatchObject({ delivered: 0, leaseLost: 1 });
  });
  it('does not start claims after its execution budget expires', async () => {
    const { outbox, queue } = fixture();
    vi.useFakeTimers();
    try {
      outbox.due.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 1000);
        return ['intent'];
      });
      expect(await dispatchOutbox(outbox, queue, { maxDurationMs: 100 })).toMatchObject({
        delivered: 0,
      });
      expect(outbox.claim).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
