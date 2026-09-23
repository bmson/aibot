import { createHash, randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import {
  affectedItems,
  PackCommandSchema,
  type PackData,
  PackDataSchema,
  type PackItem,
  PackItemSchema,
  type PackSnapshot,
  validatePack,
} from '@assistant/persistence/situations';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Pack = Records['situationPacks'];
type Preview = Records['situationPreviews'];
type Card = Records['generatedCards'];
type Revision = Records['generatedCardRevisions'];
type Commitment = Records['commitments'];
type Source = NonNullable<PackItem['source']>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = (): PackSnapshot => ({
  revision: 'missing',
  state: 'unavailable',
  title: 'Source unavailable',
  details: '',
});

function sourceKey(source: Source) {
  return `${source.kind}:${source.id}`;
}

function cardDetails(spec: unknown) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const value = spec as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 100 ||
    !Array.isArray(value.facts) ||
    value.facts.length < 1 ||
    value.facts.length > 24
  )
    return null;
  const facts: string[] = [];
  for (const entry of value.facts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const fact = entry as Record<string, unknown>;
    if (
      typeof fact.id !== 'string' ||
      typeof fact.value !== 'string' ||
      (fact.label !== undefined && typeof fact.label !== 'string') ||
      (fact.sensitive !== undefined && typeof fact.sensitive !== 'boolean')
    )
      return null;
    if (fact.sensitive !== true) facts.push(`${fact.label ?? fact.id}: ${fact.value}`);
  }
  return { title: value.title, details: facts.join('\n').slice(0, 4000) };
}

function identity<T extends { id: string; agentId: string }>(
  doc: DocumentSnapshot,
  row: T,
  id: string,
  agentId: string,
): T {
  if (row.id !== id || documentKey(id) !== doc.id || row.agentId !== agentId)
    throw new Error('Situation pack record identity mismatch');
  return row;
}

function decodePack(doc: DocumentSnapshot, id: string, agentId: string): Pack {
  return identity(doc, decodeRecord<Pack>(doc.data()), id, agentId);
}

/** Transactional owner-scoped writes for the existing situation-pack command API. */
export class FirestoreSituationPackMutationRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async command(input: unknown, options: { ownerConfirmed?: boolean } = {}) {
    const parsed = PackCommandSchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false as const,
        error: 'Invalid pack command. Check the required fields and limits.',
      };
    if (!this.configuredAgentId) return { ok: false as const, error: 'Owner unavailable.' };
    const command = parsed.data;
    try {
      return await this.store.db.runTransaction(async (tx) => {
        const ownerQuery = this.store.collection('agents').limit(2);
        const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
        const packRef =
          command.action === 'create' ? null : this.store.doc('situationPacks', command.packId);
        const [owners, erasure, packDoc] = await Promise.all([
          tx.get(ownerQuery),
          tx.get(erasureRef),
          packRef ? tx.get(packRef) : Promise.resolve(null),
        ]);
        const owner = owners.docs[0];
        if (
          owners.size !== 1 ||
          !owner ||
          owner.get('id') !== this.configuredAgentId ||
          owner.id !== documentKey(this.configuredAgentId)
        )
          throw new Error('Situation pack changes require exactly one configured owner.');
        if (
          erasure.exists &&
          (erasure.get('agentId') !== this.configuredAgentId ||
            privacyErasureIsActive(erasure.get('status')) ||
            !erasure.updateTime)
        )
          throw new Error('Privacy erasure is in progress');

        if (command.action === 'create') {
          return this.create(tx, command.title, command.creationKey);
        }
        if (!packDoc?.exists) throw new Error('This pack is unavailable.');
        const row = decodePack(packDoc, command.packId, this.configuredAgentId);
        if (row.archived && command.action !== 'forget_decision')
          throw new Error('This pack is unavailable.');
        if ('version' in command && command.version !== row.version)
          throw new Error('This pack changed. Reload it before trying again.');
        const data = PackDataSchema.parse(row.data);
        const now = this.store.now();

        if (command.action === 'archive') {
          tx.update(packDoc.ref, { archived: true, version: row.version + 1, updatedAt: now });
          return { ok: true as const, packId: row.id };
        }
        if (command.action === 'forget_decision') {
          return this.save(
            tx,
            packDoc,
            row,
            {
              ...data,
              decisions: data.decisions.filter((decision) => decision.id !== command.decisionId),
            },
            now,
          );
        }
        if (command.action === 'decision') {
          const decision = { ...command.decision, confirmed: options.ownerConfirmed === true };
          if (decision.scope === 'preference' && !decision.confirmed)
            throw new Error(
              'A lasting preference needs explicit confirmation in the pack. Save it as a situation decision first.',
            );
          return this.save(
            tx,
            packDoc,
            row,
            {
              ...data,
              decisions: [
                ...data.decisions.filter(
                  (item) =>
                    item.id !== decision.id &&
                    item.option.trim().toLocaleLowerCase() !==
                      decision.option.trim().toLocaleLowerCase(),
                ),
                decision,
              ],
            },
            now,
          );
        }
        if (command.action === 'reviewed') {
          const item = data.items.find((entry) => entry.id === command.itemId);
          if (!item) throw new Error('This item no longer exists.');
          const live = await this.loadSources(tx, this.configuredAgentId, data.items);
          const changed = data.items
            .filter(
              (entry) =>
                entry.source && digest(entry.snapshot) !== digest(this.current(entry, live)),
            )
            .map((entry) => entry.id);
          if (affectedItems(data.items, changed).includes(item.id))
            throw new Error(
              'Review the source change first; this item still depends on changed information.',
            );
          return this.save(
            tx,
            packDoc,
            row,
            {
              ...data,
              items: data.items.map((entry) =>
                entry.id === item.id ? { ...entry, needsReview: false } : entry,
              ),
            },
            now,
          );
        }
        if (command.action === 'item' || command.action === 'preview') {
          const before = data.items.find((item) => item.id === command.item.id);
          if (command.action === 'item' && before)
            throw new Error('Use a preview to change an existing item.');
          if (command.action === 'preview' && !before)
            throw new Error('Add the item before previewing a correction.');
          const after = PackItemSchema.parse(command.item);
          const live = await this.loadSources(tx, this.configuredAgentId, [...data.items, after]);
          after.snapshot = this.current(after, live);
          if (
            after.snapshot?.state === 'unavailable' &&
            (!before?.source || digest(before.source) !== digest(after.source))
          )
            throw new Error('The linked source is unavailable or belongs to another owner.');
          const next = {
            ...data,
            items: [...data.items.filter((item) => item.id !== after.id), after],
          };
          validatePack(next);
          if (command.action === 'item') return this.save(tx, packDoc, row, next, now);
          if (!before) throw new Error('Add the item before previewing a correction.');
          const previewId = randomUUID();
          const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
          const body = {
            before,
            after,
            affectedIds: affectedItems(next.items, [after.id]),
            unknowns: [
              'Only linked, stored sources were checked. Availability, travel times and external changes are not verified.',
              'Applying updates this pack only. Reminders, bookings and messages remain unchanged.',
            ],
          };
          const preview: Preview = {
            id: previewId,
            packId: row.id,
            baseVersion: row.version,
            sourceHash: digest(live),
            data: body,
            status: 'pending',
            expiresAt,
            createdAt: now,
          };
          tx.create(this.store.doc('situationPreviews', previewId), encodeRecord(preview));
          return {
            ok: true as const,
            packId: row.id,
            preview: {
              ...body,
              id: previewId,
              packId: row.id,
              baseVersion: row.version,
              expiresAt: expiresAt.toISOString(),
            },
          };
        }

        const previewRef = this.store.doc('situationPreviews', command.previewId);
        const previewDoc = await tx.get(previewRef);
        if (!previewDoc.exists || previewDoc.get('packId') !== row.id)
          throw new Error('This preview is unavailable.');
        const preview = decodeRecord<Preview>(previewDoc.data());
        if (preview.id !== command.previewId || documentKey(preview.id) !== previewDoc.id)
          throw new Error('Situation pack preview identity mismatch');
        if (command.action === 'dismiss_preview') {
          if (preview.status === 'pending') tx.update(previewRef, { status: 'dismissed' });
          return { ok: true as const, packId: row.id };
        }
        if (preview.status === 'applied') return { ok: true as const, packId: row.id };
        if (
          preview.status !== 'pending' ||
          preview.expiresAt <= now ||
          preview.baseVersion !== row.version
        )
          throw new Error('This preview is stale. Create a new preview.');
        const body = preview.data as { after?: unknown };
        const after = PackItemSchema.parse(body.after);
        const live = await this.loadSources(tx, this.configuredAgentId, [...data.items, after]);
        if (digest(live) !== preview.sourceHash)
          throw new Error('A linked source changed. Create a fresh preview before applying.');
        const affected = new Set(
          affectedItems([...data.items.filter((item) => item.id !== after.id), after], [after.id]),
        );
        const result = await this.save(
          tx,
          packDoc,
          row,
          {
            ...data,
            items: data.items.map((item) =>
              item.id === after.id
                ? after
                : affected.has(item.id)
                  ? { ...item, needsReview: true }
                  : item,
            ),
          },
          now,
        );
        tx.update(previewRef, { status: 'applied' });
        return result;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safe =
        /^(This |A linked |A dependency |A lasting |Item IDs |Decision IDs |Dependencies |Use a preview |Add the item |The linked |Review the source |Could not |Owner unavailable|Privacy erasure)/;
      return {
        ok: false as const,
        error: safe.test(message)
          ? message
          : 'Could not update the pack. Check the fields and try again.',
      };
    }
  }

  private async create(tx: Transaction, title: string, creationKey: string) {
    const agentId = this.configuredAgentId;
    const key = createHash('sha256')
      .update(JSON.stringify([agentId, creationKey]))
      .digest('hex');
    const keyRef = this.store.doc('situationPackKeys', key);
    const keyDoc = await tx.get(keyRef);
    const now = this.store.now();
    if (keyDoc.exists) {
      if (
        keyDoc.get('agentId') !== agentId ||
        keyDoc.get('creationKey') !== creationKey ||
        typeof keyDoc.get('packId') !== 'string'
      )
        throw new Error('Could not create the pack.');
      const existingRef = this.store.doc('situationPacks', keyDoc.get('packId') as string);
      const existing = await tx.get(existingRef);
      if (!existing.exists) throw new Error('Could not create the pack.');
      decodePack(existing, keyDoc.get('packId') as string, agentId);
      return { ok: true as const, packId: keyDoc.get('packId') as string };
    }
    // Backfill reservation from imported/existing records before allocating a new ID.
    const matches = await tx.get(
      this.store
        .collection('situationPacks')
        .where('agentId', '==', agentId)
        .where('creationKey', '==', creationKey)
        .limit(2),
    );
    if (matches.size > 1) throw new Error('Could not create the pack.');
    const existingDoc = matches.docs[0];
    const packId = existingDoc
      ? decodePack(existingDoc, decodeRecord<Pack>(existingDoc.data()).id, agentId).id
      : randomUUID();
    if (!existingDoc) {
      const row: Pack = {
        id: packId,
        agentId,
        title,
        creationKey,
        version: 1,
        archived: false,
        data: { items: [], decisions: [] },
        createdAt: now,
        updatedAt: now,
      };
      tx.create(this.store.doc('situationPacks', packId), encodeRecord(row));
    }
    tx.create(keyRef, encodeRecord({ agentId, creationKey, packId, createdAt: now }));
    return { ok: true as const, packId };
  }

  private save(tx: Transaction, doc: DocumentSnapshot, row: Pack, data: PackData, now: Date) {
    validatePack(data);
    tx.update(doc.ref, { data: encodeRecord(data), version: row.version + 1, updatedAt: now });
    return { ok: true as const, packId: row.id };
  }

  private current(item: PackItem, live: Record<string, PackSnapshot>) {
    return item.source ? (live[sourceKey(item.source)] ?? null) : null;
  }

  private async loadSources(tx: Transaction, agentId: string, items: PackItem[]) {
    const unique = new Map(
      items.flatMap((item) =>
        item.source ? [[sourceKey(item.source), item.source] as const] : [],
      ),
    );
    const result: Record<string, PackSnapshot> = {};
    for (const [key, source] of [...unique].sort(([a], [b]) => a.localeCompare(b))) {
      if (source.kind === 'commitment') {
        const doc = await tx.get(this.store.doc('commitments', source.id));
        if (!doc.exists) {
          result[key] = unavailable();
          continue;
        }
        const row = decodeRecord<Commitment>(doc.data());
        if (row.id !== source.id || documentKey(source.id) !== doc.id || row.agentId !== agentId) {
          result[key] = unavailable();
          continue;
        }
        result[key] = {
          revision: row.updatedAt.toISOString(),
          state: row.status,
          title: row.title,
          details: [row.details, row.nextAction, row.dueAt?.toISOString(), row.resolution]
            .filter(Boolean)
            .join('\n')
            .slice(0, 4000),
        };
      } else {
        const cardDoc = await tx.get(this.store.doc('generatedCards', source.id));
        if (!cardDoc.exists) {
          result[key] = unavailable();
          continue;
        }
        const card = decodeRecord<Card>(cardDoc.data());
        if (
          card.id !== source.id ||
          documentKey(source.id) !== cardDoc.id ||
          card.agentId !== agentId
        ) {
          result[key] = unavailable();
          continue;
        }
        const revisionDoc = await tx.get(
          this.store.doc('generatedCardRevisions', card.currentRevisionId),
        );
        const revision = revisionDoc.exists ? decodeRecord<Revision>(revisionDoc.data()) : null;
        if (
          !revision ||
          revision.id !== card.currentRevisionId ||
          revision.cardId !== card.id ||
          documentKey(revision.id) !== revisionDoc.id
        ) {
          result[key] = unavailable();
          continue;
        }
        const spec = cardDetails(revision.spec);
        result[key] = {
          revision: card.currentRevisionId,
          state:
            card.expiresAt instanceof Date && card.expiresAt <= this.store.now()
              ? 'expired'
              : card.status,
          title: spec?.title ?? 'Saved card',
          details: spec?.details ?? '',
        };
      }
    }
    return result;
  }
}
