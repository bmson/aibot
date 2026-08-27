import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The poller reaches for real work through these two modules only, so stubbing
// them is enough to drive the loop without a database or a model.
const findDueTasks = vi.hoisted(() => vi.fn());
const executeAgentTask = vi.hoisted(() => vi.fn());
const sweepStep = vi.hoisted(() => vi.fn());

vi.mock('@assistant/core', () => ({
  findDueTasks,
  backfillMessageEmbeddings: sweepStep,
  emitBudgetNotices: sweepStep,
  expireStaleApprovals: vi.fn(async () => []),
  expireStaleSuggestions: vi.fn(async () => 0),
  getAgent: vi.fn(async () => ({ id: 'agent', timezone: 'UTC' })),
  purgeAgedHistory: sweepStep,
  purgeExpired: sweepStep,
  renotifyStalledApprovals: vi.fn(async () => 0),
  renotifyStalledAttention: vi.fn(async () => 0),
  resumeResolvedApprovalTasks: vi.fn(async () => []),
  runDueSchedules: vi.fn(async () => []),
}));
vi.mock('./task-runner.js', () => ({ executeAgentTask }));
vi.mock('./executor-deps.js', () => ({
  executorDeps: () => ({ notifyApproval: vi.fn(), notifyOwner: vi.fn() }),
}));
vi.mock('./deps.js', () => ({ agentServices: () => ({}) }));

const { startPoller } = await import('./poller.js');

/** Just enough of AgentDeps for the loop; everything it touches is mocked. */
const deps = { db: {}, router: {}, modules: { sweepSteps: [], ticks: [] } } as never;

function due(...ids: string[]) {
  return ids.map((id) => ({ id, type: 'adhoc' }));
}

/** The real findDueTasks ends in `.limit(limit)`; the stub honours that too. */
function dueUpTo(...ids: string[]) {
  return (_db: unknown, limit: number) => Promise.resolve(due(...ids).slice(0, limit));
}

beforeEach(() => {
  vi.useFakeTimers();
  findDueTasks.mockReset();
  executeAgentTask.mockReset();
  findDueTasks.mockResolvedValue([]);
  executeAgentTask.mockResolvedValue({ outcome: 'done' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startPoller', () => {
  // The finding: the loop awaited each due task in turn, so one slow browser
  // or code step held every other task behind it. Compose sets
  // QUEUE_DRIVER=local, so for a self-hosted install this loop IS the queue.
  it('runs due tasks side by side instead of one after another', async () => {
    let releaseFirst: (() => void) | undefined;
    executeAgentTask.mockImplementation(async (_deps: unknown, taskId: string) => {
      if (taskId === 'slow') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { outcome: 'done' };
    });
    findDueTasks.mockResolvedValueOnce(due('slow', 'quick')).mockResolvedValue([]);

    const stop = startPoller(deps);
    await vi.advanceTimersByTimeAsync(2_000);

    // The quick task finished while the slow one is still in flight.
    const started = executeAgentTask.mock.calls.map((call) => call[1]);
    expect(started).toContain('slow');
    expect(started).toContain('quick');
    releaseFirst?.();
    stop();
  });

  it('never runs more than the concurrency budget at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    executeAgentTask.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return { outcome: 'done' };
    });
    findDueTasks.mockImplementation(dueUpTo('a', 'b', 'c', 'd', 'e'));

    const stop = startPoller(deps);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(peak).toBeLessThanOrEqual(3);
    // And it never asked for more than it had room for.
    for (const call of findDueTasks.mock.calls) expect(call[1]).toBeLessThanOrEqual(3);
    for (const release of releases) release();
    stop();
  });

  // The other half of the finding: the sweep shared the task guard, so while a
  // long task ran nothing expired approvals, fired schedules, or re-notified.
  it('sweeps on schedule even while a task is still running', async () => {
    const releases: Array<() => void> = [];
    executeAgentTask.mockImplementation(
      async () => await new Promise<void>((resolve) => releases.push(resolve)),
    );
    findDueTasks.mockResolvedValueOnce(due('endless')).mockResolvedValue([]);

    const stop = startPoller(deps);
    // Past the sweep cadence (every 30 ticks of 2s) with the task still stuck.
    await vi.advanceTimersByTimeAsync(62_000);
    expect(sweepStep).toHaveBeenCalled();
    for (const release of releases) release();
    stop();
  });
});
