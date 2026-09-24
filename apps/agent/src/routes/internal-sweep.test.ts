import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildDeps: vi.fn(),
  firestoreMaintenanceReady: vi.fn(),
  expireStaleApprovals: vi.fn(),
  resumeResolvedApprovalTasks: vi.fn(),
  renotifyStalledApprovals: vi.fn(),
  runDueSchedules: vi.fn(),
  releaseStaleReservations: vi.fn(),
  executeSqlOnlySweep: vi.fn(),
  notifyApproval: vi.fn(),
}));

vi.mock('@assistant/config', () => ({
  isModuleEnabled: () => true,
  loadConfig: () => ({ INTERNAL_AUTH_MODE: 'shared-secret' }),
}));
vi.mock('@assistant/core', () => ({
  evaluateCanaryHealth: vi.fn(),
  expireStaleApprovals: mocks.expireStaleApprovals,
  expireStaleSuggestions: mocks.executeSqlOnlySweep,
  findDueTasks: mocks.executeSqlOnlySweep,
  resumeResolvedApprovalTasks: mocks.resumeResolvedApprovalTasks,
  renotifyStalledApprovals: mocks.renotifyStalledApprovals,
  renotifyStalledAttention: mocks.executeSqlOnlySweep,
  runDueSchedules: mocks.runDueSchedules,
  releaseStaleReservations: mocks.releaseStaleReservations,
  isCodeJobEnabled: () => true,
  firestoreCodeJobUnavailable: (job: string) => (job === 'dream.run' ? 'unavailable' : null),
  backfillMessageEmbeddings: mocks.executeSqlOnlySweep,
  emitBudgetNotices: mocks.executeSqlOnlySweep,
  getAgent: mocks.executeSqlOnlySweep,
  getQueueNotifier: mocks.executeSqlOnlySweep,
  purgeAgedHistory: mocks.executeSqlOnlySweep,
  purgeExpired: mocks.executeSqlOnlySweep,
}));
vi.mock('@assistant/firestore', () => ({
  FirestoreScheduleRepository: class {
    readonly kind = 'schedule-repository';
    constructor(readonly store: unknown) {}
  },
}));
vi.mock('../deps.js', () => ({
  agentServices: vi.fn(),
  buildDeps: mocks.buildDeps,
  composedModuleMetas: [],
  firestoreMaintenanceReady: mocks.firestoreMaintenanceReady,
}));
vi.mock('../google-oidc.js', () => ({
  oidcAudienceForPath: (_audience: string, path: string) => path,
  verifyInternalAuthorization: vi.fn(async () => true),
}));
vi.mock('../canaries.js', () => ({ latestCanaryRun: vi.fn(), runCanaries: vi.fn() }));
vi.mock('../executor-deps.js', () => ({
  executorDeps: () => ({ notifyApproval: mocks.notifyApproval }),
}));

const { internal } = await import('./internal.js');

function responseDoc(data: Record<string, unknown>) {
  return {
    exists: true,
    get: (field: string) => data[field],
  };
}

function fixture() {
  const approvals = {
    expireStale: vi.fn(),
    resumeResolved: vi.fn(),
  };
  const messages = { append: vi.fn() };
  const watches = { expire: vi.fn() };
  const ownerDoc = responseDoc({ id: 'agent-1', timezone: 'America/Los_Angeles' });
  const migrationDoc = responseDoc({ status: 'active' });
  const store = {
    doc: vi.fn((collection: string, id: string) => ({
      get: async () => (collection === 'agents' && id === 'agent-1' ? ownerDoc : migrationDoc),
    })),
  };
  const db = {
    execute: vi.fn(async () => {
      throw new Error('SQL must not run');
    }),
  };
  const costs = { kind: 'cost-repository' };
  const persistence = { driver: 'firestore', approvals, messages, watches, costs };
  const deps = {
    config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_AGENT_ID: 'agent-1' },
    db,
    persistence,
    firestoreStore: store,
    router: {},
    modules: { sweepSteps: [] },
  };
  return { deps, db, ownerDoc, migrationDoc, persistence, store, approvals, watches };
}

async function postSweep() {
  return internal.request('/sweep', { method: 'POST' }, { INTERNAL_AUTH_MODE: 'shared-secret' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.expireStaleApprovals.mockResolvedValue(['task-expired']);
  mocks.resumeResolvedApprovalTasks.mockResolvedValue(['task-resumed']);
  mocks.renotifyStalledApprovals.mockResolvedValue(2);
  mocks.runDueSchedules.mockResolvedValue([{ schedule: 'morning', taskId: 'task-fired' }]);
  mocks.firestoreMaintenanceReady.mockResolvedValue(true);
  mocks.releaseStaleReservations.mockResolvedValue(4);
});

describe('POST /internal/sweep in Firestore mode', () => {
  it('runs only portable approval, watch, and schedule maintenance', async () => {
    const f = fixture();
    mocks.buildDeps.mockReturnValue(f.deps);
    f.watches.expire.mockResolvedValue(3);

    const response = await postSweep();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      expiredApprovalsWoke: 1,
      resumedApprovalTasks: 1,
      renotifiedApprovals: 2,
      expiredWatches: 3,
      schedulesFired: 1,
      releasedReservations: 4,
    });
    expect(mocks.releaseStaleReservations).toHaveBeenCalledWith(f.persistence.costs, 120, 500);
    expect(mocks.expireStaleApprovals).toHaveBeenCalledWith(f.persistence.approvals);
    expect(mocks.resumeResolvedApprovalTasks).toHaveBeenCalledWith(f.persistence.approvals);
    expect(mocks.renotifyStalledApprovals).toHaveBeenCalledWith(
      f.persistence,
      mocks.notifyApproval,
    );
    expect(f.watches.expire).toHaveBeenCalledWith('agent-1', expect.any(Date));
    expect(mocks.runDueSchedules).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'schedule-repository', store: f.store }),
      'America/Los_Angeles',
      expect.objectContaining({ prepareGoal: expect.any(Function) }),
    );
    const options = mocks.runDueSchedules.mock.calls[0]?.[2] as {
      isJobEnabled: (job: string) => boolean;
      prepareGoal: () => Promise<unknown>;
    };
    expect(options.isJobEnabled('dream.run')).toBe(false);
    expect(options.isJobEnabled('memory.consolidate')).toBe(true);
    await expect(options.prepareGoal()).resolves.toEqual({ action: 'skip' });
    expect(f.db.execute).not.toHaveBeenCalled();
    expect(mocks.executeSqlOnlySweep).not.toHaveBeenCalled();
  });

  it('blocks sweeps until the Firestore owner and migration are ready', async () => {
    const f = fixture();
    mocks.buildDeps.mockReturnValue(f.deps);
    mocks.firestoreMaintenanceReady.mockResolvedValue(false);

    const response = await postSweep();

    expect(response.status).toBe(503);
    expect(mocks.expireStaleApprovals).not.toHaveBeenCalled();
    expect(mocks.runDueSchedules).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });

  it('fails closed when a required portable repository is missing', async () => {
    const f = fixture();
    mocks.buildDeps.mockReturnValue({ ...f.deps, persistence: undefined });

    const response = await postSweep();

    expect(response.status).toBe(503);
    expect(mocks.expireStaleApprovals).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });
});
