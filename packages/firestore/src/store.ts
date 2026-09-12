import { Buffer } from 'node:buffer';
import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  FieldValue,
  Firestore,
  Timestamp,
  VectorValue,
} from '@google-cloud/firestore';

/** Encode IDs reversibly so slashes, provider IDs, and reserved names cannot change scope. */
export function documentKey(id: string): string {
  if (!id || Buffer.byteLength(id, 'utf8') > 1000) throw new Error('Invalid document identifier');
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeRecord<T>(value: unknown): T {
  function visit(input: unknown): unknown {
    if (input instanceof Timestamp) return input.toDate();
    if (input instanceof VectorValue) return input.toArray();
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object' && !(input instanceof Date) && !Buffer.isBuffer(input)) {
      return Object.fromEntries(Object.entries(input).map(([key, field]) => [key, visit(field)]));
    }
    return input;
  }
  return visit(value) as T;
}

/** Skip absent optional object fields; an undefined array element is always a programming error. */
export function encodeRecord(value: DocumentData): DocumentData {
  function visit(input: unknown): unknown {
    if (input === undefined) throw new Error('Undefined array value cannot be persisted');
    if (input instanceof Date) {
      if (!Number.isFinite(input.getTime())) throw new Error('Invalid persisted timestamp');
      return input;
    }
    if (
      input instanceof FieldValue ||
      input instanceof VectorValue ||
      input instanceof Timestamp ||
      Buffer.isBuffer(input)
    ) {
      return input;
    }
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .map(([key, v]) => [key, visit(v)]),
      );
    }
    if (typeof input === 'number' && !Number.isFinite(input))
      throw new Error('Nonfinite persisted number');
    return input;
  }
  return visit(value) as DocumentData;
}

export class InstallationStore {
  readonly root: DocumentReference;

  constructor(
    readonly db: Firestore,
    readonly installationId: string,
    readonly now: () => Date = () => new Date(),
    readonly projectId?: string,
    readonly databaseId = '(default)',
  ) {
    this.root = db.collection('installations').doc(documentKey(installationId));
  }

  collection(name: string): CollectionReference {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid collection');
    return this.root.collection(name);
  }

  doc(collection: string, id: string): DocumentReference {
    return this.collection(collection).doc(documentKey(id));
  }
}

export function createInstallationStore(input: {
  projectId: string;
  installationId: string;
  databaseId?: string;
}): InstallationStore {
  if (!input.projectId) throw new Error('Firestore requires a project ID');
  return new InstallationStore(
    new Firestore({ projectId: input.projectId, databaseId: input.databaseId ?? '(default)' }),
    input.installationId,
    undefined,
    input.projectId,
    input.databaseId ?? '(default)',
  );
}
