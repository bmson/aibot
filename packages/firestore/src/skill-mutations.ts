import { randomUUID } from 'node:crypto';
import {
  type EmbeddingSpace,
  type OwnerSkillInput,
  type SkillMutationRepository,
  validateEmbedding,
  validateSkillEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import { FieldValue, type Transaction } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { skillFromDocument } from './skill-library.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Writes and hard-deletes owner skills under the configured-agent erasure fence. */
export class FirestoreSkillMutationRepository implements SkillMutationRepository {
  readonly kind = 'skill-mutation-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly space?: EmbeddingSpace,
  ) {}

  async assertOwnerWritable(agentId: string): Promise<void> {
    if (!agentId) throw new Error('Skill owner is required');
    await this.store.db.runTransaction((tx) => this.ownerFence(tx, agentId), { readOnly: true });
  }

  private validateWrite(embedding: number[]): EmbeddingSpace {
    if (!this.space) throw new Error('Skill writes require an embedding space');
    validateSkillEmbeddingSpace(this.space);
    validateEmbedding(this.space, embedding);
    return this.space;
  }

  private async ownerFence(tx: Transaction, agentId: string): Promise<void> {
    const agents = await tx.get(this.store.collection('agents').limit(2));
    const agent = agents.docs[0];
    if (
      agents.size !== 1 ||
      !agent ||
      agent.id !== documentKey(agentId) ||
      agent.get('id') !== agentId
    )
      throw new Error('Skill mutation requires one matching configured owner');
    const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
    if (
      erasure.exists &&
      (erasure.get('agentId') !== agentId ||
        privacyErasureIsActive(erasure.get('status')) ||
        !erasure.updateTime)
    )
      throw new Error('Privacy erasure is in progress');
  }

  async saveOwner(agentId: string, input: OwnerSkillInput, embedding: number[]): Promise<void> {
    const space = this.validateWrite(embedding);
    if (!agentId || !input.name || !input.steps) throw new Error('Name and steps are required.');
    await this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx, agentId);
      const skills = await tx.get(
        this.store.collection('skills').where('agentId', '==', agentId).limit(501),
      );
      if (skills.size > 500)
        throw new Error('Learned-skill library exceeds the mobile workspace limit');
      const matches = skills.docs.filter((doc) => doc.get('name') === input.name);
      if (matches.length > 1) throw new Error('Duplicate learned-skill name');
      const existing = matches[0];
      const now = this.store.now();
      const revision = randomUUID();
      if (existing) {
        this.validExisting(existing.data(), existing.id, agentId);
        tx.update(existing.ref, {
          preconditions: input.preconditions,
          steps: input.steps,
          gotchas: input.gotchas,
          embedding: FieldValue.vector(embedding),
          embeddingSpace: embeddingSpaceKey(space),
          retrievalRevision: revision,
          ownerAuthored: true,
          deprecated: false,
          lastVerifiedAt: now,
          updatedAt: now,
        });
      } else {
        if (skills.size >= 500)
          throw new Error('Learned-skill library exceeds the mobile workspace limit');
        const id = randomUUID();
        tx.create(
          this.store.doc('skills', id),
          encodeRecord({
            id,
            agentId,
            name: input.name,
            preconditions: input.preconditions,
            steps: input.steps,
            gotchas: input.gotchas,
            embedding: FieldValue.vector(embedding),
            embeddingSpace: embeddingSpaceKey(space),
            retrievalRevision: revision,
            sourceTaskId: null,
            originTrust: 'owner',
            ownerAuthored: true,
            useCount: 0,
            successCount: 0,
            failureCount: 0,
            lastVerifiedAt: now,
            deprecated: false,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
    });
  }

  async editOwner(
    agentId: string,
    skillId: string,
    input: OwnerSkillInput,
    embedding: number[],
  ): Promise<void> {
    const space = this.validateWrite(embedding);
    if (!agentId || !skillId || !input.name || !input.steps)
      throw new Error('Name and steps are required.');
    await this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx, agentId);
      const skills = await tx.get(
        this.store.collection('skills').where('agentId', '==', agentId).limit(501),
      );
      if (skills.size > 500)
        throw new Error('Learned-skill library exceeds the mobile workspace limit');
      const ref = this.store.doc('skills', skillId);
      const existing = await tx.get(ref);
      if (!existing.exists || existing.get('agentId') !== agentId)
        throw new Error('Skill not found');
      this.validExisting(existing.data(), existing.id, agentId);
      if (skills.docs.some((doc) => doc.id !== ref.id && doc.get('name') === input.name))
        throw new Error('Duplicate learned-skill name');
      const now = this.store.now();
      tx.update(ref, {
        name: input.name,
        preconditions: input.preconditions,
        steps: input.steps,
        gotchas: input.gotchas,
        embedding: FieldValue.vector(embedding),
        embeddingSpace: embeddingSpaceKey(space),
        retrievalRevision: randomUUID(),
        ownerAuthored: true,
        deprecated: false,
        updatedAt: now,
      });
    });
  }

  private validExisting(value: unknown, documentId: string, agentId: string): void {
    skillFromDocument(value, documentId, agentId);
    const row = decodeRecord<Record<string, unknown>>(value);
    if (
      !(row.createdAt instanceof Date) ||
      !Number.isFinite(row.createdAt.getTime()) ||
      (row.originTrust !== 'owner' && row.originTrust !== 'assistant') ||
      !(row.sourceTaskId === null || typeof row.sourceTaskId === 'string') ||
      !(
        row.lastVerifiedAt === null ||
        (row.lastVerifiedAt instanceof Date && Number.isFinite(row.lastVerifiedAt.getTime()))
      ) ||
      !(row.embedding === null || Array.isArray(row.embedding))
    )
      throw new Error('Invalid learned-skill document');
    if (Array.isArray(row.embedding)) {
      validateSkillEmbedding(row.embedding as number[]);
      if (
        typeof row.embeddingSpace !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.embeddingSpace) ||
        typeof row.retrievalRevision !== 'string' ||
        !row.retrievalRevision
      )
        throw new Error('Invalid learned-skill vector provenance');
    }
  }

  setDeprecated(agentId: string, skillId: string, deprecated: boolean): Promise<void> {
    if (typeof deprecated !== 'boolean') throw new Error('deprecated must be a boolean');
    return this.change(agentId, skillId, deprecated);
  }

  delete(agentId: string, skillId: string): Promise<void> {
    return this.change(agentId, skillId, null);
  }

  private async change(
    agentId: string,
    skillId: string,
    deprecated: boolean | null,
  ): Promise<void> {
    if (!agentId || !skillId) throw new Error('Skill owner and ID are required');
    await this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx, agentId);

      const ref = this.store.doc('skills', skillId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId)
        throw new Error('Skill not found');
      this.validExisting(snapshot.data(), snapshot.id, agentId);

      if (deprecated === null) tx.delete(ref);
      else tx.update(ref, { deprecated, updatedAt: this.store.now() });
    });
  }
}
