import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

/**
 * Provider-level write fence for the Neon PostgreSQL source.
 *
 * The fence disables the source branch's read-write compute endpoint through the
 * Neon API. Neon then suspends that compute and refuses new connections from
 * every role, including pooled connections and console/SQL-editor sessions, so
 * no principal can write to the source branch regardless of its SQL privileges.
 * The final export reads a separate snapshot branch created after the fence,
 * served only by a read-only (hot standby) compute, so the exporter cannot
 * write either. A witness branch created after the export proves that the
 * source branch did not advance past the snapshot LSN in the meantime.
 *
 * Nothing here prints credentials. Probe errors are reduced to SQLSTATE codes.
 */

export const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export type NeonEndpoint = {
  id: string;
  branch_id: string;
  project_id: string;
  host: string;
  type: 'read_write' | 'read_only';
  current_state: string;
  pending_state?: string;
  disabled?: boolean;
  suspended_at?: string;
  last_active?: string;
};

export type NeonOperation = {
  id: string;
  action: string;
  status: string;
  branch_id?: string;
  endpoint_id?: string;
  created_at: string;
  updated_at?: string;
};

export type NeonBranch = {
  id: string;
  name: string;
  parent_id?: string;
  parent_lsn?: string;
  created_at?: string;
};

/** Minimal Neon API surface used by the fence. A fake implements it in tests. */
export type NeonApi = {
  getEndpoint(projectId: string, endpointId: string): Promise<NeonEndpoint>;
  setEndpointDisabled(
    projectId: string,
    endpointId: string,
    disabled: boolean,
  ): Promise<{ endpoint: NeonEndpoint; operations: NeonOperation[] }>;
  getOperation(projectId: string, operationId: string): Promise<NeonOperation>;
  listOperations(projectId: string, since: string): Promise<NeonOperation[]>;
  createBranch(
    projectId: string,
    request: { parentId: string; name: string; expiresAt?: string },
  ): Promise<{ branch: NeonBranch; endpoints: NeonEndpoint[]; operations: NeonOperation[] }>;
  getBranch(projectId: string, branchId: string): Promise<NeonBranch>;
  deleteBranch(projectId: string, branchId: string): Promise<{ operations: NeonOperation[] }>;
};

export type ConnectionAttempt = {
  connected: boolean;
  /** True when a PostgreSQL server or the Neon proxy answered with an error. */
  refusedByServer: boolean;
  /** SQLSTATE or a coarse network class. Never a message, which can carry connection details. */
  code: string;
};

export type ReadOnlyProof = {
  readable: boolean;
  inRecovery: boolean;
  readWriteRejectedCode: string | null;
  xidRejectedCode: string | null;
  replayLsn: string | null;
};

export type SessionSample = {
  total: number;
  withTransactionId: number;
  byRole: Record<string, number>;
  byApplication: Record<string, number>;
  byState: Record<string, number>;
};

export type PrimaryWriteState = { inRecovery: boolean; transactionReadOnly: string };

/** PostgreSQL probes. The real implementation opens one short-lived connection per call. */
export type SqlProbe = {
  tryConnect(url: string): Promise<ConnectionAttempt>;
  readOnlyProof(url: string): Promise<ReadOnlyProof>;
  sessionInventory(url: string): Promise<SessionSample>;
  primaryWriteState(url: string): Promise<PrimaryWriteState>;
};

export type NeonFenceTarget = {
  projectId: string;
  branchId: string;
  endpointId: string;
};

export type Clock = { now(): Date; sleep(ms: number): Promise<void> };

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const NEON_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const ENDPOINT_ID = /^ep-[a-z0-9-]+$/;
const TERMINAL_OK = new Set(['finished', 'skipped']);
const TERMINAL_FAILED = new Set(['failed', 'error', 'cancelled']);
/** SQLSTATEs PostgreSQL returns for write attempts on a hot standby. */
const STANDBY_WRITE_REJECTIONS = new Set(['25006', '0A000']);

export function validateFenceTarget(target: NeonFenceTarget): NeonFenceTarget {
  if (!NEON_ID.test(target.projectId)) throw new Error('Invalid Neon project ID');
  if (!/^br-[a-z0-9-]+$/.test(target.branchId)) throw new Error('Invalid Neon branch ID');
  if (!ENDPOINT_ID.test(target.endpointId)) throw new Error('Invalid Neon endpoint ID');
  return target;
}

/**
 * Replace a Neon connection URL's host with another endpoint host, keeping
 * credentials, database, and query unchanged. Refuses non-Neon hosts, and
 * refuses a source URL that belongs to a different endpoint than the fenced one.
 */
export function neonUrlForHost(
  sourceUrl: string,
  expectedEndpointId: string,
  host: string,
  options: { pooled?: boolean } = {},
): string {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('Source database URL must be a PostgreSQL URL');
  const sourceEndpoint = url.hostname.split('.')[0]?.replace(/-pooler$/, '');
  if (sourceEndpoint !== expectedEndpointId)
    throw new Error('Source database URL does not belong to the fenced Neon endpoint');
  if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host))
    throw new Error('Refusing a non-Neon endpoint host');
  const [first, ...rest] = host.split('.');
  url.hostname = options.pooled ? [`${first}-pooler`, ...rest].join('.') : host;
  return url.toString();
}

async function waitForOperations(
  api: NeonApi,
  projectId: string,
  operations: NeonOperation[],
  clock: Clock,
  timeoutMs = 10 * 60_000,
): Promise<NeonOperation[]> {
  const deadline = clock.now().getTime() + timeoutMs;
  const settled: NeonOperation[] = [];
  for (const operation of operations) {
    let current = operation;
    while (!TERMINAL_OK.has(current.status)) {
      if (TERMINAL_FAILED.has(current.status))
        throw new Error(`Neon operation ${current.id} (${current.action}) ended ${current.status}`);
      if (clock.now().getTime() > deadline)
        throw new Error(`Neon operation ${current.id} did not finish in time`);
      await clock.sleep(2_000);
      current = await api.getOperation(projectId, operation.id);
    }
    settled.push(current);
  }
  return settled;
}

async function waitForIdle(
  api: NeonApi,
  target: NeonFenceTarget,
  clock: Clock,
  timeoutMs = 5 * 60_000,
): Promise<NeonEndpoint> {
  const deadline = clock.now().getTime() + timeoutMs;
  for (;;) {
    const endpoint = await api.getEndpoint(target.projectId, target.endpointId);
    if (endpoint.disabled === true && endpoint.current_state === 'idle' && !endpoint.pending_state)
      return endpoint;
    if (clock.now().getTime() > deadline)
      throw new Error('Fenced Neon endpoint did not reach disabled idle state in time');
    await clock.sleep(3_000);
  }
}

function endpointSummary(endpoint: NeonEndpoint) {
  return {
    id: endpoint.id,
    branchId: endpoint.branch_id,
    type: endpoint.type,
    host: endpoint.host,
    currentState: endpoint.current_state,
    pendingState: endpoint.pending_state ?? null,
    disabled: endpoint.disabled === true,
    suspendedAt: endpoint.suspended_at ?? null,
  };
}

function operationSummary(operation: NeonOperation) {
  return {
    id: operation.id,
    action: operation.action,
    status: operation.status,
    endpointId: operation.endpoint_id ?? null,
    branchId: operation.branch_id ?? null,
    createdAt: operation.created_at,
  };
}

async function checkTarget(api: NeonApi, target: NeonFenceTarget): Promise<NeonEndpoint> {
  const endpoint = await api.getEndpoint(target.projectId, target.endpointId);
  if (endpoint.project_id !== target.projectId || endpoint.branch_id !== target.branchId)
    throw new Error('Neon endpoint does not belong to the configured project and branch');
  if (endpoint.type !== 'read_write')
    throw new Error('The fence target must be the branch read-write endpoint');
  return endpoint;
}

/** Read-only: provider state plus, when the source is live, a session inventory. */
export async function neonFenceStatus(
  api: NeonApi,
  probe: SqlProbe,
  target: NeonFenceTarget,
  sourceUrl: string | undefined,
) {
  const endpoint = await checkTarget(api, target);
  const sessions =
    sourceUrl && endpoint.disabled !== true
      ? await probe.sessionInventory(neonUrlForHost(sourceUrl, target.endpointId, endpoint.host))
      : null;
  return { endpoint: endpointSummary(endpoint), sessions };
}

/**
 * Disable the source read-write endpoint. Requires the explicit confirmation
 * flag. Idempotent: an already-disabled endpoint is re-verified, not toggled.
 */
export async function applyNeonFence(
  api: NeonApi,
  probe: SqlProbe,
  target: NeonFenceTarget,
  options: { confirm: boolean; sourceUrl?: string; clock?: Clock },
) {
  if (!options.confirm)
    throw new Error('Applying the Neon write fence requires --confirm-production-fence');
  const clock = options.clock ?? systemClock;
  const before = await checkTarget(api, target);
  // A last live inventory records which principals the fence is about to cut off.
  const sessionsBeforeFence =
    options.sourceUrl && before.disabled !== true
      ? await probe
          .sessionInventory(neonUrlForHost(options.sourceUrl, target.endpointId, before.host))
          .catch(() => null)
      : null;
  const requestedAt = clock.now().toISOString();
  let operations: NeonOperation[] = [];
  if (before.disabled !== true) {
    const response = await api.setEndpointDisabled(target.projectId, target.endpointId, true);
    operations = await waitForOperations(api, target.projectId, response.operations, clock);
  }
  const after = await waitForIdle(api, target, clock);
  return {
    kind: 'neon-endpoint-disabled' as const,
    target,
    requestedAt,
    completedAt: clock.now().toISOString(),
    alreadyFenced: before.disabled === true,
    before: endpointSummary(before),
    after: endpointSummary(after),
    operations: operations.map(operationSummary),
    // The provider audit identifier the cutover records as the source write fence.
    fenceId:
      operations.length > 0
        ? `neon:${target.projectId}:${operations.map((operation) => operation.id).join('+')}`
        : `neon:${target.projectId}:${target.endpointId}:disabled-before-${requestedAt}`,
    sessionsBeforeFence,
  };
}

export type FenceSample = {
  at: string;
  endpointDisabled: boolean;
  endpointIdle: boolean;
  directConnection: ConnectionAttempt;
  pooledConnection: ConnectionAttempt;
  ok: boolean;
};

/**
 * Prove the fence holds over time. Every sample must show the endpoint
 * disabled and idle, and both direct and pooled connections refused by the
 * Neon proxy (a local network failure is inconclusive, not a pass). Provider
 * operations since the fence are listed; any compute start other than Neon's
 * own availability check fails the proof.
 */
export async function verifyNeonFence(
  api: NeonApi,
  probe: SqlProbe,
  target: NeonFenceTarget,
  options: {
    sourceUrl: string;
    fencedAt: string;
    samples: number;
    intervalMs: number;
    /**
     * Neon documents that a disabled endpoint is still periodically started by
     * its own check_availability operations. When set, compute starts that
     * coincide with an availability check are reported as warnings instead of
     * failing; client connections must still be refused in every sample, and
     * the post-export witness LSN remains the decisive data-level proof.
     */
    allowAvailabilityStarts?: boolean;
    clock?: Clock;
  },
) {
  if (!Number.isInteger(options.samples) || options.samples < 2)
    throw new Error('Fence verification needs at least two samples; one quiet sample is not proof');
  if (options.intervalMs < 0) throw new Error('Invalid sample interval');
  const clock = options.clock ?? systemClock;
  const samples: FenceSample[] = [];
  for (let index = 0; index < options.samples; index++) {
    if (index > 0) await clock.sleep(options.intervalMs);
    const endpoint = await checkTarget(api, target);
    const direct = await probe.tryConnect(
      neonUrlForHost(options.sourceUrl, target.endpointId, endpoint.host),
    );
    const pooled = await probe.tryConnect(
      neonUrlForHost(options.sourceUrl, target.endpointId, endpoint.host, { pooled: true }),
    );
    const endpointDisabled = endpoint.disabled === true;
    const endpointIdle = endpoint.current_state === 'idle' && !endpoint.pending_state;
    samples.push({
      at: clock.now().toISOString(),
      endpointDisabled,
      endpointIdle,
      directConnection: direct,
      pooledConnection: pooled,
      ok:
        endpointDisabled &&
        endpointIdle &&
        !direct.connected &&
        direct.refusedByServer &&
        !pooled.connected &&
        pooled.refusedByServer,
    });
  }
  const operations = (await api.listOperations(target.projectId, options.fencedAt)).filter(
    (operation) =>
      operation.endpoint_id === target.endpointId &&
      operation.created_at >= options.fencedAt &&
      operation.action !== 'suspend_compute' &&
      operation.action !== 'apply_config',
  );
  const availabilityChecks = operations.filter((op) => op.action === 'check_availability');
  const nearCheck = (op: NeonOperation) =>
    availabilityChecks.some(
      (check) => Math.abs(Date.parse(check.created_at) - Date.parse(op.created_at)) <= 120_000,
    );
  const availabilityStarts = options.allowAvailabilityStarts
    ? operations.filter((op) => op.action === 'start_compute' && nearCheck(op))
    : [];
  const unexpected = operations.filter(
    (op) => op.action !== 'check_availability' && !availabilityStarts.includes(op),
  );
  const firstAt = samples[0]?.at ?? options.fencedAt;
  const lastAt = samples.at(-1)?.at ?? options.fencedAt;
  return {
    kind: 'neon-fence-verification' as const,
    target,
    fencedAt: options.fencedAt,
    firstSampleAt: firstAt,
    lastSampleAt: lastAt,
    observedSeconds: Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 1000),
    samples,
    availabilityChecks: availabilityChecks.map(operationSummary),
    availabilityStarts: availabilityStarts.map(operationSummary),
    unexpectedOperations: unexpected.map(operationSummary),
    passed: samples.every((sample) => sample.ok) && unexpected.length === 0,
  };
}

function lsnValue(lsn: string): bigint {
  const match = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(lsn);
  if (!match?.[1] || !match[2]) throw new Error('Invalid PostgreSQL LSN');
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
}

async function branchLsn(
  api: NeonApi,
  probe: SqlProbe,
  projectId: string,
  branch: NeonBranch,
  endpoint: NeonEndpoint,
  sourceUrl: string,
  sourceEndpointId: string,
) {
  const reported = branch.parent_lsn ?? (await api.getBranch(projectId, branch.id)).parent_lsn;
  const proof = await probe.readOnlyProof(
    neonUrlForHost(sourceUrl, sourceEndpointId, endpoint.host),
  );
  const lsn = reported ?? proof.replayLsn;
  if (!lsn) throw new Error('Neon did not report a branch LSN and the replica has no replay LSN');
  lsnValue(lsn);
  return {
    lsn,
    lsnSource: reported ? ('neon-parent-lsn' as const) : ('replay-lsn' as const),
    proof,
  };
}

function readOnlyProofPassed(proof: ReadOnlyProof): boolean {
  return (
    proof.readable &&
    proof.inRecovery &&
    proof.readWriteRejectedCode !== null &&
    STANDBY_WRITE_REJECTIONS.has(proof.readWriteRejectedCode) &&
    proof.xidRejectedCode !== null &&
    STANDBY_WRITE_REJECTIONS.has(proof.xidRejectedCode)
  );
}

/**
 * Create the final-export snapshot branch from the fenced source branch head,
 * served only by a read-only compute. Returns the connection URL separately so
 * the caller can store it in Secret Manager without it entering evidence.
 */
export async function createSnapshotBranch(
  api: NeonApi,
  probe: SqlProbe,
  target: NeonFenceTarget,
  options: { confirm: boolean; sourceUrl: string; name: string; clock?: Clock },
) {
  if (!options.confirm)
    throw new Error('Creating the fenced snapshot branch requires --confirm-snapshot-branch');
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(options.name)) throw new Error('Invalid branch name');
  const clock = options.clock ?? systemClock;
  const source = await checkTarget(api, target);
  if (source.disabled !== true)
    throw new Error('Refusing to snapshot an unfenced source; apply the fence first');
  const created = await api.createBranch(target.projectId, {
    parentId: target.branchId,
    name: options.name,
  });
  const operations = await waitForOperations(api, target.projectId, created.operations, clock);
  const endpoint = created.endpoints.find((item) => item.type === 'read_only');
  if (!endpoint || created.endpoints.some((item) => item.type !== 'read_only'))
    throw new Error('Snapshot branch must be served by exactly read-only computes');
  const { lsn, lsnSource, proof } = await branchLsn(
    api,
    probe,
    target.projectId,
    created.branch,
    endpoint,
    options.sourceUrl,
    target.endpointId,
  );
  const evidence = {
    kind: 'neon-snapshot-branch' as const,
    target,
    branch: { id: created.branch.id, name: created.branch.name, parentId: target.branchId },
    endpoint: endpointSummary(endpoint),
    lsn,
    lsnSource,
    readOnlyProof: proof,
    operations: operations.map(operationSummary),
    createdAt: clock.now().toISOString(),
    passed: readOnlyProofPassed(proof),
  };
  return {
    evidence,
    exportUrl: neonUrlForHost(options.sourceUrl, target.endpointId, endpoint.host),
  };
}

/**
 * After the final export, branch the source head again and compare LSNs. An
 * unchanged LSN proves no WAL reached the source branch between the snapshot and
 * this witness, so the export is the final source state. The witness is
 * short-lived and deleted after the comparison.
 */
export async function witnessSourceUnchanged(
  api: NeonApi,
  probe: SqlProbe,
  target: NeonFenceTarget,
  options: {
    confirm: boolean;
    sourceUrl: string;
    snapshotLsn: string;
    snapshotLsnSource: 'neon-parent-lsn' | 'replay-lsn';
    name: string;
    clock?: Clock;
  },
) {
  if (!options.confirm)
    throw new Error('Creating the witness branch requires --confirm-witness-branch');
  const clock = options.clock ?? systemClock;
  const source = await checkTarget(api, target);
  const expiresAt = new Date(clock.now().getTime() + 60 * 60_000).toISOString().slice(0, 19);
  const created = await api.createBranch(target.projectId, {
    parentId: target.branchId,
    name: options.name,
    expiresAt: `${expiresAt}Z`,
  });
  await waitForOperations(api, target.projectId, created.operations, clock);
  const endpoint = created.endpoints.find((item) => item.type === 'read_only');
  if (!endpoint) throw new Error('Witness branch has no read-only compute');
  let deleted = false;
  try {
    const { lsn, lsnSource } = await branchLsn(
      api,
      probe,
      target.projectId,
      created.branch,
      endpoint,
      options.sourceUrl,
      target.endpointId,
    );
    // Compare like with like: a Neon-reported branch LSN and a replica replay LSN
    // are not guaranteed to be the same position for an unchanged branch.
    const comparable = lsnSource === options.snapshotLsnSource;
    const unchanged = comparable && lsnValue(lsn) === lsnValue(options.snapshotLsn);
    const removal = await api.deleteBranch(target.projectId, created.branch.id);
    await waitForOperations(api, target.projectId, removal.operations, clock);
    deleted = true;
    return {
      kind: 'neon-source-witness' as const,
      target,
      sourceStillFenced: source.disabled === true,
      snapshotLsn: options.snapshotLsn,
      snapshotLsnSource: options.snapshotLsnSource,
      witnessLsn: lsn,
      witnessLsnSource: lsnSource,
      witnessBranchId: created.branch.id,
      witnessDeleted: deleted,
      checkedAt: clock.now().toISOString(),
      passed: unchanged && source.disabled === true,
    };
  } finally {
    if (!deleted)
      await api.deleteBranch(target.projectId, created.branch.id).catch(() => undefined);
  }
}

/** Reverse the fence without touching data: re-enable the endpoint and prove it accepts writes. */
export async function removeNeonFence(
  api: NeonApi,
  probe: SqlProbe,
  target: NeonFenceTarget,
  options: { confirm: boolean; sourceUrl: string; clock?: Clock },
) {
  if (!options.confirm)
    throw new Error('Removing the Neon write fence requires --confirm-production-unfence');
  const clock = options.clock ?? systemClock;
  const before = await checkTarget(api, target);
  let operations: NeonOperation[] = [];
  if (before.disabled === true) {
    const response = await api.setEndpointDisabled(target.projectId, target.endpointId, false);
    operations = await waitForOperations(api, target.projectId, response.operations, clock);
  }
  const after = await checkTarget(api, target);
  // Connecting starts the compute; the read-write state is read, never exercised by a write.
  const state = await probe.primaryWriteState(
    neonUrlForHost(options.sourceUrl, target.endpointId, after.host),
  );
  return {
    kind: 'neon-endpoint-enabled' as const,
    target,
    before: endpointSummary(before),
    after: endpointSummary(after),
    operations: operations.map(operationSummary),
    primaryWriteState: state,
    completedAt: clock.now().toISOString(),
    passed: after.disabled !== true && !state.inRecovery && state.transactionReadOnly === 'off',
  };
}

// ---------------------------------------------------------------------------
// Real adapters. Not exercised by unit tests; they only run in an owner session.

export function createNeonApi(apiKey: string, fetcher: typeof fetch = fetch): NeonApi {
  if (!apiKey || /\s/.test(apiKey)) throw new Error('NEON_API_KEY is missing or malformed');
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetcher(`${NEON_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`Neon API ${method} ${path} failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
  return {
    async getEndpoint(projectId, endpointId) {
      return (
        await request<{ endpoint: NeonEndpoint }>(
          'GET',
          `${project(projectId)}/endpoints/${encodeURIComponent(endpointId)}`,
        )
      ).endpoint;
    },
    async setEndpointDisabled(projectId, endpointId, disabled) {
      return request('PATCH', `${project(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, {
        endpoint: { disabled },
      });
    },
    async getOperation(projectId, operationId) {
      return (
        await request<{ operation: NeonOperation }>(
          'GET',
          `${project(projectId)}/operations/${encodeURIComponent(operationId)}`,
        )
      ).operation;
    },
    async listOperations(projectId, since) {
      const result: NeonOperation[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
        const body = await request<{
          operations: NeonOperation[];
          pagination?: { cursor?: string };
        }>('GET', `${project(projectId)}/operations?${query}`);
        result.push(...body.operations);
        const oldest = body.operations.at(-1)?.created_at;
        cursor = body.pagination?.cursor;
        if (!cursor || body.operations.length === 0 || (oldest && oldest < since)) break;
      }
      return result;
    },
    async createBranch(projectId, { parentId, name, expiresAt }) {
      return request('POST', `${project(projectId)}/branches`, {
        branch: { parent_id: parentId, name, ...(expiresAt ? { expires_at: expiresAt } : {}) },
        endpoints: [{ type: 'read_only' }],
      });
    },
    async getBranch(projectId, branchId) {
      return (
        await request<{ branch: NeonBranch }>(
          'GET',
          `${project(projectId)}/branches/${encodeURIComponent(branchId)}`,
        )
      ).branch;
    },
    async deleteBranch(projectId, branchId) {
      return request('DELETE', `${project(projectId)}/branches/${encodeURIComponent(branchId)}`);
    },
  };
}

type PostgresError = { code?: unknown; severity?: unknown; errno?: unknown };

function classifyError(error: unknown): { refusedByServer: boolean; code: string } {
  const value = (error ?? {}) as PostgresError;
  if (typeof value.severity === 'string' || /^[0-9A-Z]{5}$/.test(String(value.code ?? '')))
    return {
      refusedByServer: true,
      code: /^[0-9A-Z]{5}$/.test(String(value.code)) ? String(value.code) : 'SERVER_ERROR',
    };
  // ENOTFOUND, ECONNREFUSED, ETIMEDOUT etc. prove nothing about the provider fence.
  return { refusedByServer: false, code: typeof value.code === 'string' ? value.code : 'NETWORK' };
}

/** The subset of postgres.js used here; the package lives in @assistant/db, not the root. */
type SqlTag = <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
type SqlClient = SqlTag & {
  begin<T>(run: (tx: SqlTag) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
};

export function createPostgresProbe(): SqlProbe {
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const postgres = require('postgres') as (url: string, options: object) => SqlClient;
  const connect = (url: string) =>
    postgres(url, {
      max: 1,
      connect_timeout: 15,
      idle_timeout: 1,
      prepare: false,
      onnotice: () => undefined,
      connection: { application_name: 'assistant-cutover-fence-probe' },
    });
  const code = async (run: () => Promise<unknown>): Promise<string | null> => {
    try {
      await run();
      return null;
    } catch (error) {
      return classifyError(error).code;
    }
  };
  return {
    async tryConnect(url) {
      const sql = connect(url);
      try {
        await sql`select 1`;
        return { connected: true, refusedByServer: false, code: 'CONNECTED' };
      } catch (error) {
        return { connected: false, ...classifyError(error) };
      } finally {
        await sql.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    async readOnlyProof(url) {
      const sql = connect(url);
      try {
        const [row] = await sql<
          { in_recovery: boolean; replay_lsn: string | null }[]
        >`select pg_is_in_recovery() as in_recovery, pg_last_wal_replay_lsn()::text as replay_lsn`;
        const readable =
          (await code(() => sql`select count(*) from information_schema.tables`)) === null;
        const readWriteRejectedCode = await code(() =>
          sql.begin(async (tx) => {
            await tx`set transaction read write`;
            await tx`select 1`;
            throw Object.assign(new Error('rollback'), { code: 'ROLLBACK_ONLY' });
          }),
        );
        const xidRejectedCode = await code(() =>
          sql.begin(async (tx) => {
            await tx`select pg_current_xact_id()`;
            throw Object.assign(new Error('rollback'), { code: 'ROLLBACK_ONLY' });
          }),
        );
        return {
          readable,
          inRecovery: row?.in_recovery === true,
          readWriteRejectedCode:
            readWriteRejectedCode === 'ROLLBACK_ONLY' ? null : readWriteRejectedCode,
          xidRejectedCode: xidRejectedCode === 'ROLLBACK_ONLY' ? null : xidRejectedCode,
          replayLsn: row?.replay_lsn ?? null,
        };
      } finally {
        await sql.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    async sessionInventory(url) {
      const sql = connect(url);
      try {
        // Aggregates only: no query text, client addresses, or PIDs leave the database.
        const rows = await sql<
          { role: string | null; application: string | null; state: string | null; xid: boolean }[]
        >`select usename as role, application_name as application, state,
                 backend_xid is not null as xid
            from pg_stat_activity
           where backend_type = 'client backend' and pid <> pg_backend_pid()`;
        const count = (key: 'role' | 'application' | 'state') =>
          rows.reduce<Record<string, number>>((result, row) => {
            const name = row[key] || '(none)';
            result[name] = (result[name] ?? 0) + 1;
            return result;
          }, {});
        return {
          total: rows.length,
          withTransactionId: rows.filter((row) => row.xid).length,
          byRole: count('role'),
          byApplication: count('application'),
          byState: count('state'),
        };
      } finally {
        await sql.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    async primaryWriteState(url) {
      const sql = connect(url);
      try {
        const [row] = await sql<
          { in_recovery: boolean; read_only: string }[]
        >`select pg_is_in_recovery() as in_recovery, current_setting('transaction_read_only') as read_only`;
        return { inRecovery: row?.in_recovery === true, transactionReadOnly: row?.read_only ?? '' };
      } finally {
        await sql.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
}

export async function writeEvidenceFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'project-id': { type: 'string' },
      'branch-id': { type: 'string' },
      'endpoint-id': { type: 'string' },
      out: { type: 'string' },
      'fenced-at': { type: 'string' },
      samples: { type: 'string', default: '3' },
      'interval-seconds': { type: 'string', default: '300' },
      'snapshot-lsn': { type: 'string' },
      'snapshot-lsn-source': { type: 'string', default: 'neon-parent-lsn' },
      'allow-availability-starts': { type: 'boolean', default: false },
      name: { type: 'string' },
      'confirm-production-fence': { type: 'boolean', default: false },
      'confirm-production-unfence': { type: 'boolean', default: false },
      'confirm-snapshot-branch': { type: 'boolean', default: false },
      'confirm-witness-branch': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const command = positionals[0];
  const target = validateFenceTarget({
    projectId: values['project-id'] ?? '',
    branchId: values['branch-id'] ?? '',
    endpointId: values['endpoint-id'] ?? '',
  });
  const api = createNeonApi(process.env.NEON_API_KEY ?? '');
  const probe = createPostgresProbe();
  // Supplied by the owner from Secret Manager; never printed or written to evidence.
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const needUrl = () => {
    if (!sourceUrl) throw new Error('Set SOURCE_DATABASE_URL from the database-url secret');
    return sourceUrl;
  };
  let result: unknown;
  switch (command) {
    case 'status':
      result = await neonFenceStatus(api, probe, target, sourceUrl);
      break;
    case 'fence':
      result = await applyNeonFence(api, probe, target, {
        confirm: values['confirm-production-fence'] === true,
        sourceUrl,
      });
      break;
    case 'verify':
      if (!values['fenced-at']) throw new Error('verify requires --fenced-at');
      result = await verifyNeonFence(api, probe, target, {
        sourceUrl: needUrl(),
        fencedAt: new Date(values['fenced-at']).toISOString(),
        samples: Number(values.samples),
        intervalMs: Number(values['interval-seconds']) * 1000,
        allowAvailabilityStarts: values['allow-availability-starts'] === true,
      });
      break;
    case 'snapshot-branch': {
      const created = await createSnapshotBranch(api, probe, target, {
        confirm: values['confirm-snapshot-branch'] === true,
        sourceUrl: needUrl(),
        name: values.name ?? `cutover-final-${Date.now()}`,
      });
      result = created.evidence;
      break;
    }
    case 'witness':
      if (!values['snapshot-lsn']) throw new Error('witness requires --snapshot-lsn');
      result = await witnessSourceUnchanged(api, probe, target, {
        confirm: values['confirm-witness-branch'] === true,
        sourceUrl: needUrl(),
        snapshotLsn: values['snapshot-lsn'],
        snapshotLsnSource:
          values['snapshot-lsn-source'] === 'replay-lsn' ? 'replay-lsn' : 'neon-parent-lsn',
        name: values.name ?? `cutover-witness-${Date.now()}`,
      });
      break;
    case 'unfence':
      result = await removeNeonFence(api, probe, target, {
        confirm: values['confirm-production-unfence'] === true,
        sourceUrl: needUrl(),
      });
      break;
    default:
      throw new Error(
        'Usage: cutover-neon-fence status|fence|verify|snapshot-branch|witness|unfence',
      );
  }
  if (values.out) await writeEvidenceFile(values.out, result);
  console.log(JSON.stringify(result, null, 2));
  if ((result as { passed?: boolean }).passed === false) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
