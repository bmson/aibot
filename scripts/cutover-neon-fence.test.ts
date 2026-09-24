import { describe, expect, it, vi } from 'vitest';
import {
  applyNeonFence,
  type Clock,
  createSnapshotBranch,
  type NeonApi,
  type NeonEndpoint,
  type NeonOperation,
  neonUrlForHost,
  removeNeonFence,
  type SqlProbe,
  validateFenceTarget,
  verifyNeonFence,
  witnessSourceUnchanged,
} from './cutover-neon-fence.js';

const target = { projectId: 'proud-sun-123', branchId: 'br-main-1', endpointId: 'ep-main-1' };
const sourceUrl =
  'postgres://app:secret@ep-main-1-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require';

function fakeClock(start = Date.parse('2026-09-24T08:00:00Z')): Clock & { elapsed: number } {
  let now = start;
  return {
    get elapsed() {
      return now - start;
    },
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
  };
}

function fakeNeon(options: {
  branchLsn?: string;
  witnessLsn?: string;
  extraOps?: NeonOperation[];
}) {
  const endpoint: NeonEndpoint = {
    id: target.endpointId,
    branch_id: target.branchId,
    project_id: target.projectId,
    host: 'ep-main-1.us-west-2.aws.neon.tech',
    type: 'read_write',
    current_state: 'active',
    disabled: false,
  };
  const operations: NeonOperation[] = [...(options.extraOps ?? [])];
  let branches = 0;
  const deleted: string[] = [];
  const api: NeonApi & { endpoint: NeonEndpoint; deleted: string[] } = {
    endpoint,
    deleted,
    getEndpoint: vi.fn(async () => ({ ...endpoint })),
    setEndpointDisabled: vi.fn(async (_project, _id, disabled) => {
      endpoint.disabled = disabled;
      endpoint.current_state = disabled ? 'idle' : 'active';
      const op: NeonOperation = {
        id: `op-${operations.length + 1}`,
        action: disabled ? 'suspend_compute' : 'start_compute',
        status: 'running',
        endpoint_id: endpoint.id,
        created_at: '2026-09-24T08:00:00Z',
      };
      operations.push(op);
      return { endpoint: { ...endpoint }, operations: [op] };
    }),
    getOperation: vi.fn(async (_project, id) => ({
      ...(operations.find((op) => op.id === id) as NeonOperation),
      status: 'finished',
    })),
    listOperations: vi.fn(async () => operations),
    createBranch: vi.fn(async (_project, request) => {
      branches++;
      const id = `br-child-${branches}`;
      return {
        branch: {
          id,
          name: request.name,
          parent_lsn:
            branches === 1 ? options.branchLsn : (options.witnessLsn ?? options.branchLsn),
        },
        endpoints: [
          {
            ...endpoint,
            id: `ep-child-${branches}`,
            branch_id: id,
            host: `ep-child-${branches}.us-west-2.aws.neon.tech`,
            type: 'read_only' as const,
            disabled: false,
            current_state: 'active',
          },
        ],
        operations: [
          {
            id: `op-branch-${branches}`,
            action: 'create_branch',
            status: 'finished',
            created_at: '',
          },
        ],
      };
    }),
    getBranch: vi.fn(async (_project, id) => ({ id, name: id })),
    deleteBranch: vi.fn(async (_project, id) => {
      deleted.push(id);
      return { operations: [] };
    }),
  };
  return api;
}

function fakeProbe(overrides: Partial<SqlProbe> = {}): SqlProbe {
  return {
    tryConnect: vi.fn(async () => ({ connected: false, refusedByServer: true, code: 'XX000' })),
    readOnlyProof: vi.fn(async () => ({
      readable: true,
      inRecovery: true,
      readWriteRejectedCode: '0A000',
      xidRejectedCode: '25006',
      replayLsn: '0/5A1B2C3D',
    })),
    sessionInventory: vi.fn(async () => ({
      total: 2,
      withTransactionId: 0,
      byRole: { app: 2 },
      byApplication: { '(none)': 2 },
      byState: { idle: 2 },
    })),
    primaryWriteState: vi.fn(async () => ({ inRecovery: false, transactionReadOnly: 'off' })),
    ...overrides,
  };
}

describe('neon URL host swap', () => {
  it('keeps credentials and path while changing only the endpoint host', () => {
    const snapshot = neonUrlForHost(sourceUrl, 'ep-main-1', 'ep-child-1.us-west-2.aws.neon.tech');
    const parsed = new URL(snapshot);
    expect(parsed.hostname).toBe('ep-child-1.us-west-2.aws.neon.tech');
    expect(parsed.username).toBe('app');
    expect(parsed.pathname).toBe('/neondb');
    expect(parsed.search).toBe('?sslmode=require');
    expect(
      new URL(
        neonUrlForHost(sourceUrl, 'ep-main-1', 'ep-main-1.us-west-2.aws.neon.tech', {
          pooled: true,
        }),
      ).hostname,
    ).toBe('ep-main-1-pooler.us-west-2.aws.neon.tech');
  });

  it('refuses a URL for a different endpoint or a non-Neon host', () => {
    expect(() => neonUrlForHost(sourceUrl, 'ep-other', 'ep-x.us-west-2.aws.neon.tech')).toThrow(
      'does not belong',
    );
    expect(() => neonUrlForHost(sourceUrl, 'ep-main-1', 'db.example.com')).toThrow('non-Neon');
    expect(() => validateFenceTarget({ ...target, endpointId: 'main' })).toThrow('endpoint');
  });
});

describe('neon provider write fence', () => {
  it('requires the explicit confirmation flag before disabling the endpoint', async () => {
    const api = fakeNeon({});
    await expect(applyNeonFence(api, fakeProbe(), target, { confirm: false })).rejects.toThrow(
      '--confirm-production-fence',
    );
    expect(api.setEndpointDisabled).not.toHaveBeenCalled();
  });

  it('disables the read-write endpoint, waits for the suspend, and records the audit ID', async () => {
    const api = fakeNeon({});
    const probe = fakeProbe();
    const result = await applyNeonFence(api, probe, target, {
      confirm: true,
      sourceUrl,
      clock: fakeClock(),
    });
    expect(api.setEndpointDisabled).toHaveBeenCalledWith(target.projectId, target.endpointId, true);
    expect(result.after).toMatchObject({ disabled: true, currentState: 'idle' });
    expect(result.fenceId).toBe('neon:proud-sun-123:op-1');
    expect(result.sessionsBeforeFence).toMatchObject({ total: 2, byRole: { app: 2 } });
    expect(JSON.stringify(result)).not.toContain('secret');

    // Re-running is idempotent and does not toggle the endpoint again.
    const again = await applyNeonFence(api, probe, target, { confirm: true, clock: fakeClock() });
    expect(again.alreadyFenced).toBe(true);
    expect(api.setEndpointDisabled).toHaveBeenCalledTimes(1);
  });

  it('refuses a read-only endpoint or one on another branch as the fence target', async () => {
    const api = fakeNeon({});
    api.endpoint.type = 'read_only';
    await expect(
      applyNeonFence(api, fakeProbe(), target, { confirm: true, clock: fakeClock() }),
    ).rejects.toThrow('read-write endpoint');
    api.endpoint.type = 'read_write';
    api.endpoint.branch_id = 'br-other';
    await expect(
      applyNeonFence(api, fakeProbe(), target, { confirm: true, clock: fakeClock() }),
    ).rejects.toThrow('configured project and branch');
  });
});

describe('neon fence verification', () => {
  it('passes only with repeated server-side refusals on direct and pooled hosts', async () => {
    const api = fakeNeon({});
    await applyNeonFence(api, fakeProbe(), target, { confirm: true, clock: fakeClock() });
    const clock = fakeClock();
    const result = await verifyNeonFence(api, fakeProbe(), target, {
      sourceUrl,
      fencedAt: '2026-09-24T08:00:00.000Z',
      samples: 3,
      intervalMs: 600_000,
      clock,
    });
    expect(result.passed).toBe(true);
    expect(result.samples).toHaveLength(3);
    expect(result.observedSeconds).toBe(1200);
    expect(clock.elapsed).toBe(1_200_000);
  });

  it('rejects a single sample, a network failure, or an unfenced endpoint', async () => {
    const api = fakeNeon({});
    await expect(
      verifyNeonFence(api, fakeProbe(), target, {
        sourceUrl,
        fencedAt: '2026-09-24T08:00:00.000Z',
        samples: 1,
        intervalMs: 0,
      }),
    ).rejects.toThrow('at least two samples');

    const unfenced = await verifyNeonFence(api, fakeProbe(), target, {
      sourceUrl,
      fencedAt: '2026-09-24T08:00:00.000Z',
      samples: 2,
      intervalMs: 0,
      clock: fakeClock(),
    });
    expect(unfenced.passed).toBe(false);

    await applyNeonFence(api, fakeProbe(), target, { confirm: true, clock: fakeClock() });
    const offline = fakeProbe({
      tryConnect: vi.fn(async () => ({
        connected: false,
        refusedByServer: false,
        code: 'ENOTFOUND',
      })),
    });
    const network = await verifyNeonFence(api, offline, target, {
      sourceUrl,
      fencedAt: '2026-09-24T08:00:00.000Z',
      samples: 2,
      intervalMs: 0,
      clock: fakeClock(),
    });
    expect(network.passed).toBe(false);
  });

  it('fails on a compute start after the fence unless it matches an availability check', async () => {
    const start: NeonOperation = {
      id: 'op-start',
      action: 'start_compute',
      status: 'finished',
      endpoint_id: target.endpointId,
      created_at: '2026-09-24T08:10:00.000Z',
    };
    const check: NeonOperation = {
      id: 'op-check',
      action: 'check_availability',
      status: 'finished',
      endpoint_id: target.endpointId,
      created_at: '2026-09-24T08:10:30.000Z',
    };
    const api = fakeNeon({ extraOps: [start, check] });
    await applyNeonFence(api, fakeProbe(), target, { confirm: true, clock: fakeClock() });
    const base = {
      sourceUrl,
      fencedAt: '2026-09-24T08:00:00.000Z',
      samples: 2,
      intervalMs: 0,
    };
    const strict = await verifyNeonFence(api, fakeProbe(), target, { ...base, clock: fakeClock() });
    expect(strict.passed).toBe(false);
    expect(strict.unexpectedOperations.map((op) => op.id)).toEqual(['op-start']);

    const tolerant = await verifyNeonFence(api, fakeProbe(), target, {
      ...base,
      allowAvailabilityStarts: true,
      clock: fakeClock(),
    });
    expect(tolerant.passed).toBe(true);
    expect(tolerant.availabilityStarts.map((op) => op.id)).toEqual(['op-start']);
  });
});

describe('fenced snapshot and witness branches', () => {
  it('refuses to snapshot an unfenced source', async () => {
    const api = fakeNeon({ branchLsn: '0/5A1B2C3D' });
    await expect(
      createSnapshotBranch(api, fakeProbe(), target, {
        confirm: true,
        sourceUrl,
        name: 'cutover-final',
        clock: fakeClock(),
      }),
    ).rejects.toThrow('unfenced source');
    expect(api.createBranch).not.toHaveBeenCalled();
  });

  it('creates a read-only snapshot with hot-standby write rejection proof', async () => {
    const api = fakeNeon({ branchLsn: '0/5A1B2C3D' });
    await applyNeonFence(api, fakeProbe(), target, { confirm: true, clock: fakeClock() });
    const { evidence, exportUrl } = await createSnapshotBranch(api, fakeProbe(), target, {
      confirm: true,
      sourceUrl,
      name: 'cutover-final',
      clock: fakeClock(),
    });
    expect(evidence).toMatchObject({
      passed: true,
      lsn: '0/5A1B2C3D',
      lsnSource: 'neon-parent-lsn',
    });
    expect(new URL(exportUrl).hostname).toBe('ep-child-1.us-west-2.aws.neon.tech');
    expect(JSON.stringify(evidence)).not.toContain('secret');

    const writable = fakeProbe({
      readOnlyProof: vi.fn(async () => ({
        readable: true,
        inRecovery: false,
        readWriteRejectedCode: null,
        xidRejectedCode: null,
        replayLsn: null,
      })),
    });
    const second = await createSnapshotBranch(api, writable, target, {
      confirm: true,
      sourceUrl,
      name: 'cutover-final-2',
      clock: fakeClock(),
    });
    expect(second.evidence.passed).toBe(false);
  });

  it('proves the source did not advance and always deletes the witness', async () => {
    const same = fakeNeon({ branchLsn: '0/5A1B2C3D' });
    await applyNeonFence(same, fakeProbe(), target, { confirm: true, clock: fakeClock() });
    await same.createBranch(target.projectId, { parentId: target.branchId, name: 'snapshot' });
    const unchanged = await witnessSourceUnchanged(same, fakeProbe(), target, {
      confirm: true,
      sourceUrl,
      snapshotLsn: '0/5A1B2C3D',
      snapshotLsnSource: 'neon-parent-lsn',
      name: 'cutover-witness',
      clock: fakeClock(),
    });
    expect(unchanged).toMatchObject({ passed: true, witnessDeleted: true });
    expect(same.deleted).toEqual(['br-child-2']);

    const moved = fakeNeon({ branchLsn: '0/5A1B2C3D', witnessLsn: '0/5A1B2D00' });
    await applyNeonFence(moved, fakeProbe(), target, { confirm: true, clock: fakeClock() });
    await moved.createBranch(target.projectId, { parentId: target.branchId, name: 'snapshot' });
    const advanced = await witnessSourceUnchanged(moved, fakeProbe(), target, {
      confirm: true,
      sourceUrl,
      snapshotLsn: '0/5A1B2C3D',
      snapshotLsnSource: 'neon-parent-lsn',
      name: 'cutover-witness',
      clock: fakeClock(),
    });
    expect(advanced.passed).toBe(false);
    expect(moved.deleted).toEqual(['br-child-2']);
  });
});

describe('neon fence removal', () => {
  it('re-enables the endpoint and proves it is writable without writing', async () => {
    const api = fakeNeon({});
    await applyNeonFence(api, fakeProbe(), target, { confirm: true, clock: fakeClock() });
    await expect(
      removeNeonFence(api, fakeProbe(), target, { confirm: false, sourceUrl }),
    ).rejects.toThrow('--confirm-production-unfence');
    const result = await removeNeonFence(api, fakeProbe(), target, {
      confirm: true,
      sourceUrl,
      clock: fakeClock(),
    });
    expect(api.setEndpointDisabled).toHaveBeenLastCalledWith(
      target.projectId,
      target.endpointId,
      false,
    );
    expect(result).toMatchObject({ passed: true, after: { disabled: false } });
  });
});
