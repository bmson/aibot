import { createHash } from 'node:crypto';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Commitment = {
  id: string;
  agentId: string;
  kind: string;
  title: string;
  details: string;
  nextAction: string;
  status: string;
  snoozedUntil: Date | null;
  resolvedAt: Date | null;
  resolution: string | null;
  confidence: string;
  contentHash: string;
  updatedAt: Date;
};

type Correction = { title: string; details: string; nextAction: string };

function validCommitment(snapshot: DocumentSnapshot, agentId: string): Commitment | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<Commitment>(snapshot.data());
  if (row.agentId !== agentId) return null;
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    typeof row.kind !== 'string' ||
    typeof row.title !== 'string' ||
    typeof row.details !== 'string' ||
    typeof row.nextAction !== 'string' ||
    !['open', 'snoozed', 'resolved', 'dismissed', 'stale'].includes(row.status)
  )
    throw new Error('Commitment mutation found a malformed owner row');
  return row;
}

function contentHash(kind: string, title: string, details: string): string {
  return createHash('sha256')
    .update(`${kind}\n${title.trim().toLowerCase()}\n${details.trim().toLowerCase()}`)
    .digest('hex');
}

/** Atomic owner-fenced commitment mutations used by the mobile memory desk. */
export class FirestoreCommitmentMutationRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private async ownerFence(tx: Transaction): Promise<void> {
    const agents = await tx.get(this.store.collection('agents').limit(2));
    const owner = agents.docs[0];
    if (
      !this.configuredAgentId ||
      agents.size !== 1 ||
      !owner ||
      owner.id !== documentKey(this.configuredAgentId) ||
      owner.get('id') !== this.configuredAgentId
    )
      throw new Error('Commitment mutation requires one matching configured owner');
    const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.configuredAgentId));
    if (
      erasure.exists &&
      (erasure.get('agentId') !== this.configuredAgentId ||
        privacyErasureIsActive(erasure.get('status')) ||
        !erasure.updateTime)
    )
      throw new Error('Privacy erasure is in progress');
  }

  private async mutate(
    id: string,
    apply: (row: Commitment, now: Date) => Record<string, unknown>,
  ): Promise<boolean> {
    if (!id) return false;
    const ref = this.store.doc('commitments', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx);
      const snapshot = await tx.get(ref);
      const row = validCommitment(snapshot, this.configuredAgentId);
      if (!row || !['open', 'snoozed'].includes(row.status)) return false;
      tx.update(ref, apply(row, this.store.now()));
      return true;
    });
  }

  resolve(id: string, resolution: string): Promise<boolean> {
    return this.mutate(id, (_row, now) => ({
      status: 'resolved',
      resolvedAt: now,
      snoozedUntil: null,
      resolution,
      updatedAt: now,
    }));
  }

  snooze(id: string, until: Date): Promise<boolean> {
    if (!Number.isFinite(until.getTime()) || until <= this.store.now())
      throw new Error('A commitment can only be snoozed until a valid future date.');
    return this.mutate(id, (_row, now) => ({
      status: 'snoozed',
      snoozedUntil: until,
      updatedAt: now,
    }));
  }

  dismiss(id: string): Promise<boolean> {
    return this.mutate(id, (_row, now) => ({
      status: 'dismissed',
      resolvedAt: now,
      snoozedUntil: null,
      resolution: 'Dismissed by owner',
      updatedAt: now,
    }));
  }

  correct(id: string, patch: Correction): Promise<boolean> {
    const title = patch.title.trim().replace(/\s+/g, ' ').slice(0, 180);
    if (!title) throw new Error('A commitment title is required.');
    const details = patch.details.trim().slice(0, 500);
    const nextAction = patch.nextAction.trim().slice(0, 240);
    if (!id) return Promise.resolve(false);
    const ref = this.store.doc('commitments', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx);
      const snapshot = await tx.get(ref);
      const row = validCommitment(snapshot, this.configuredAgentId);
      if (!row || !['open', 'snoozed'].includes(row.status)) return false;
      const hash = contentHash(row.kind, title, details);
      const duplicates = await tx.get(
        this.store
          .collection('commitments')
          .where('agentId', '==', this.configuredAgentId)
          .where('contentHash', '==', hash)
          .limit(10),
      );
      if (
        duplicates.docs.some(
          (doc) =>
            doc.id !== snapshot.id && ['open', 'snoozed'].includes(String(doc.get('status'))),
        )
      )
        throw new Error('A matching active commitment already exists.');
      const now = this.store.now();
      tx.update(ref, {
        title,
        details,
        nextAction,
        confidence: '1.00',
        contentHash: hash,
        updatedAt: now,
      });
      return true;
    });
  }
}
