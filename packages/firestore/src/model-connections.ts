import {
  isRoutableModel,
  type ModelCatalogRepository,
  type ModelCatalogWrite,
  type ModelConnectionRepository,
  type ModelRoleAssignment,
  type Records,
} from '@assistant/persistence';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Row = Records['modelConnections'];

function validRow(id: string, docId: string, value: unknown): Row | null {
  const row = decodeRecord<Row>(value);
  if (
    row?.id !== id ||
    documentKey(row.id) !== docId ||
    typeof row.kind !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.enabled !== 'boolean' ||
    !(row.updatedAt instanceof Date)
  )
    return null;
  return row;
}

/** Installation-wide provider connections, alongside the model catalog they serve. */
export class FirestoreModelConnectionRepository implements ModelConnectionRepository {
  readonly kind = 'model-connection-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async list(): Promise<Row[]> {
    const page = await this.store.collection('modelConnections').orderBy('label', 'asc').get();
    return page.docs.flatMap((doc) => {
      const row = validRow(String(doc.get('id')), doc.id, doc.data());
      return row ? [row] : [];
    });
  }

  async upsert(input: Parameters<ModelConnectionRepository['upsert']>[0]): Promise<Row> {
    const ref = this.store.doc('modelConnections', input.id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? validRow(input.id, ref.id, snapshot.data()) : null;
      if (snapshot.exists && !existing) throw new Error('Stored model connection is malformed');
      const now = this.store.now();
      const row: Row = {
        id: input.id,
        kind: input.kind,
        label: input.label,
        baseUrl: input.baseUrl,
        apiKeyEncrypted:
          input.apiKeyEncrypted !== undefined
            ? input.apiKeyEncrypted
            : (existing?.apiKeyEncrypted ?? null),
        vertexProject: input.vertexProject,
        vertexLocation: input.vertexLocation,
        enabled: input.enabled,
        lastTestedAt: existing?.lastTestedAt ?? null,
        lastError: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      tx.set(ref, encodeRecord(row));
      return row;
    });
  }

  private async patch(id: string, change: (row: Row) => Partial<Row>): Promise<boolean> {
    const ref = this.store.doc('modelConnections', id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const row = snapshot.exists ? validRow(id, ref.id, snapshot.data()) : null;
      if (!row) return false;
      tx.set(ref, encodeRecord({ ...row, ...change(row) }));
      return true;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.patch(id, () => ({ enabled, updatedAt: this.store.now() }));
  }

  /** Leaves updatedAt alone so a test result does not rebuild the router's adapter. */
  recordTest(id: string, result: { ok: boolean; error?: string }): Promise<boolean> {
    return this.patch(id, () => ({
      lastTestedAt: this.store.now(),
      lastError: result.ok ? null : (result.error ?? 'failed'),
    }));
  }

  async remove(id: string): Promise<boolean> {
    const ref = this.store.doc('modelConnections', id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      tx.delete(ref);
      return true;
    });
  }
}

/** The owner-editable model catalog and role routing, installation-wide. */
export class FirestoreModelCatalogRepository implements ModelCatalogRepository {
  readonly kind = 'model-catalog-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async listModels(): Promise<Records['models'][]> {
    const page = await this.store.collection('models').orderBy('label', 'asc').get();
    return page.docs.flatMap((doc) => {
      const row = decodeRecord<Records['models']>(doc.data());
      return typeof row?.id === 'string' && documentKey(row.id) === doc.id ? [row] : [];
    });
  }

  async listRoles(): Promise<Records['modelRoles'][]> {
    const page = await this.store.collection('modelRoles').get();
    return page.docs
      .flatMap((doc) => {
        const row = decodeRecord<Records['modelRoles']>(doc.data());
        return typeof row?.role === 'string' && documentKey(row.role) === doc.id ? [row] : [];
      })
      .sort((left, right) => left.role.localeCompare(right.role));
  }

  async upsertModel(input: ModelCatalogWrite): Promise<void> {
    const ref = this.store.doc('models', input.id);
    await this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? decodeRecord<Records['models']>(snapshot.data()) : null;
      if (existing && existing.id !== input.id) throw new Error('Model identity mismatch');
      const now = this.store.now();
      tx.set(
        ref,
        encodeRecord({ ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }),
      );
    });
  }

  async assignRoles(assignments: readonly ModelRoleAssignment[]): Promise<void> {
    if (assignments.length === 0) return;
    await this.store.db.runTransaction(async (tx) => {
      const wanted = [...new Set(assignments.flatMap((a) => [a.primaryModel, a.fallbackModel]))];
      const roleRefs = assignments.map((a) => this.store.doc('modelRoles', a.role));
      const modelRefs = wanted.map((id) => this.store.doc('models', id));
      const snapshots = await tx.getAll(...roleRefs, ...modelRefs);
      const roles = snapshots.slice(0, roleRefs.length);
      const catalog = snapshots.slice(roleRefs.length);
      catalog.forEach((snapshot, index) => {
        const row = snapshot.exists ? decodeRecord<Records['models']>(snapshot.data()) : null;
        if (row?.id !== wanted[index] || !isRoutableModel(row))
          throw new Error(`Model ${wanted[index]} is not enabled with prices`);
      });
      assignments.forEach((assignment, index) => {
        const snapshot = roles[index];
        const row = snapshot?.exists ? decodeRecord<Records['modelRoles']>(snapshot.data()) : null;
        if (!snapshot || row?.role !== assignment.role)
          throw new Error(`Unknown model role: ${assignment.role}`);
        tx.set(
          snapshot.ref,
          encodeRecord({
            ...row,
            primaryModel: assignment.primaryModel,
            fallbackModel: assignment.fallbackModel,
            updatedAt: this.store.now(),
          }),
        );
      });
    });
  }
}
