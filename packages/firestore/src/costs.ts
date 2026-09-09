import { createHash, randomUUID } from 'node:crypto';
import {
  addMicros,
  type CostEventInput,
  type CostRepository,
  type CostTotals,
  microsToUsd,
  nextUtcDailyReset,
  nextUtcMonthlyReset,
  type ReservationActual,
  type ReserveCostInput,
  type ReserveOutcome,
  usdToMicros,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

interface Policy {
  dailyLimitMicros: number;
  monthlyLimitMicros: number;
  softPct: number;
}

function integer(snapshot: DocumentSnapshot, field: string): number {
  const value: unknown = snapshot.get(field) ?? 0;
  if (typeof value !== 'number') throw new Error(`Invalid ledger counter ${field}`);
  microsToUsd(value);
  return value;
}

function policy(snapshot: DocumentSnapshot): Policy {
  if (!snapshot.exists) throw new Error('Budget policy has not been initialized');
  const data = snapshot.data() as Policy;
  microsToUsd(data.dailyLimitMicros);
  microsToUsd(data.monthlyLimitMicros);
  if (!Number.isInteger(data.softPct) || data.softPct < 0 || data.softPct > 100) {
    throw new Error('Invalid budget policy');
  }
  return data;
}

function fingerprint(input: ReserveCostInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.source,
        usdToMicros(input.estimatedUsd),
        input.taskId ?? null,
        input.description ?? '',
      ]),
    )
    .digest('hex');
}

/** Counters, hold transitions, ledger events, and per-task spend commit together. */
export class FirestoreCostRepository implements CostRepository {
  readonly kind = 'cost-repository' as const;

  constructor(private readonly store: InstallationStore) {}

  async getRate(key: string) {
    const snapshot = await this.store.doc('rateTable', key).get();
    if (!snapshot.exists) return null;
    const unitPriceUsd = Number(snapshot.get('unitPriceUsd'));
    if (!Number.isFinite(unitPriceUsd) || unitPriceUsd < 0) throw new Error('Invalid cost rate');
    return { unit: String(snapshot.get('unit')), unitPriceUsd };
  }

  private refs(now: Date, taskId?: string | null) {
    return {
      policy: this.store.doc('coordination', 'budget-policy'),
      holds: this.store.doc('coordination', 'budget-holds'),
      daily: this.store.doc('budgetPeriods', `day:${now.toISOString().slice(0, 10)}`),
      monthly: this.store.doc('budgetPeriods', `month:${now.toISOString().slice(0, 7)}`),
      ...(taskId
        ? {
            task: this.store.doc('tasks', taskId),
            taskHolds: this.store.doc('taskBudgetHolds', taskId),
          }
        : {}),
    };
  }

  async totals(): Promise<CostTotals> {
    return this.store.db.runTransaction(
      async (tx) => {
        const refs = this.refs(this.store.now());
        const [p, holds, daily, monthly] = await tx.getAll(
          refs.policy,
          refs.holds,
          refs.daily,
          refs.monthly,
        );
        if (!p || !holds || !daily || !monthly) throw new Error('Incomplete budget snapshot');
        const limits = policy(p);
        return {
          dailySpentUsd: microsToUsd(integer(daily, 'spentMicros')),
          monthlySpentUsd: microsToUsd(integer(monthly, 'spentMicros')),
          heldUsd: microsToUsd(integer(holds, 'heldMicros')),
          dailyLimitUsd: microsToUsd(limits.dailyLimitMicros),
          monthlyLimitUsd: microsToUsd(limits.monthlyLimitMicros),
          softPct: limits.softPct,
        };
      },
      { readOnly: true },
    );
  }

  async reserve(input: ReserveCostInput): Promise<ReserveOutcome> {
    const amount = usdToMicros(input.estimatedUsd);
    if (amount <= 0) throw new Error('Cost estimate must be at least one microdollar');
    const id = input.operationId ?? randomUUID();
    const ref = this.store.doc('costReservations', id);
    const signature = fingerprint(input);
    return this.store.db.runTransaction(async (tx): Promise<ReserveOutcome> => {
      const now = this.store.now();
      const refs = this.refs(now, input.taskId);
      const [existing, p, holds, daily, monthly] = await tx.getAll(
        ref,
        refs.policy,
        refs.holds,
        refs.daily,
        refs.monthly,
      );
      if (!existing || !p || !holds || !daily || !monthly)
        throw new Error('Incomplete budget snapshot');
      if (existing.exists) {
        if (existing.get('fingerprint') !== signature)
          throw new Error('Reservation ID reused for different work');
        if (existing.get('status') === 'held') return { ok: true, reservationId: id };
        return {
          ok: false,
          reason: 'reservation already closed; do not repeat provider work',
          resumeAt: nextUtcDailyReset(now),
        };
      }
      const limits = policy(p);
      const held = integer(holds, 'heldMicros');
      const factor = input.critical ? 1.1 : 1;
      for (const [name, spent, cap, reset] of [
        [
          'monthly',
          integer(monthly, 'spentMicros'),
          limits.monthlyLimitMicros,
          nextUtcMonthlyReset(now),
        ],
        ['daily', integer(daily, 'spentMicros'), limits.dailyLimitMicros, nextUtcDailyReset(now)],
      ] as const) {
        if (addMicros(spent, held, amount) > Math.floor(cap * factor)) {
          return {
            ok: false,
            reason: `${name} budget cannot cover this reservation`,
            resumeAt: reset,
          };
        }
      }
      let taskHeld = 0;
      if (refs.task && refs.taskHolds) {
        const [task, taskHolds] = await tx.getAll(refs.task, refs.taskHolds);
        if (!task?.exists || !taskHolds) throw new Error('Reservation task does not exist');
        taskHeld = integer(taskHolds, 'heldMicros');
        const spent = usdToMicros(Number(task.get('spentUsd') ?? 0));
        const limit = usdToMicros(Number(task.get('budgetUsdLimit')));
        if (addMicros(spent, taskHeld, amount) > Math.floor(limit * factor)) {
          return {
            ok: false,
            reason: 'task budget cannot cover this reservation',
            resumeAt: nextUtcDailyReset(now),
          };
        }
      }
      tx.set(refs.holds, { heldMicros: addMicros(held, amount) });
      if (refs.taskHolds) tx.set(refs.taskHolds, { heldMicros: addMicros(taskHeld, amount) });
      tx.create(ref, {
        id,
        taskId: input.taskId ?? null,
        source: input.source,
        estimatedUsd: microsToUsd(amount).toFixed(6),
        actualUsd: null,
        status: 'held',
        description: input.description ?? '',
        fingerprint: signature,
        createdAt: now,
        reconciledAt: null,
      });
      return { ok: true, reservationId: id };
    });
  }

  private async settle(
    tx: Transaction,
    reservationId: string | null,
    actual: ReservationActual | null,
    direct?: CostEventInput,
    eventId = randomUUID(),
    staleBefore?: Date,
  ): Promise<boolean> {
    const now = this.store.now();
    const reservationRef = reservationId ? this.store.doc('costReservations', reservationId) : null;
    const reservation = reservationRef ? await tx.get(reservationRef) : null;
    if (reservationRef && (!reservation?.exists || reservation.get('status') !== 'held'))
      return false;
    if (staleBefore && reservation) {
      const created = decodeRecord<Date>(reservation.get('createdAt'));
      if (!(created instanceof Date) || created >= staleBefore) return false;
    }
    const taskId: string | null = reservation?.get('taskId') ?? direct?.taskId ?? null;
    const refs = this.refs(now, taskId);
    // Reservation status and event creation commit together, so the status guard
    // provides deduplication while the event retains its public UUID as its document ID.
    const eventRef = this.store.doc('costEvents', eventId);
    const [holds, daily, monthly, event] = await tx.getAll(
      refs.holds,
      refs.daily,
      refs.monthly,
      eventRef,
    );
    if (!holds || !daily || !monthly || !event) throw new Error('Incomplete ledger snapshot');
    if (event.exists) throw new Error('Ledger event already exists without a settled reservation');
    const writesEvent = actual !== null || direct !== undefined;
    const amount = usdToMicros(actual?.usd ?? direct?.usd ?? 0);
    const estimated = reservation ? usdToMicros(Number(reservation.get('estimatedUsd'))) : 0;
    const held = integer(holds, 'heldMicros');
    if (held < estimated) throw new Error('Budget hold underflow');
    const shouldAddTaskSpend = writesEvent && Boolean(reservation || direct?.addToTaskSpend);
    let taskHeld = 0;
    let taskSpent = 0;
    if (refs.task && refs.taskHolds) {
      const [task, taskHolds] = await tx.getAll(refs.task, refs.taskHolds);
      if (!taskHolds || (!task?.exists && shouldAddTaskSpend))
        throw new Error('Ledger task does not exist');
      taskHeld = integer(taskHolds, 'heldMicros');
      taskSpent = usdToMicros(Number(task?.get('spentUsd') ?? 0));
      if (taskHeld < estimated) throw new Error('Task hold underflow');
    }
    // All reads are complete before any writes: Firestore may rerun this callback.
    if (reservationRef) {
      tx.update(reservationRef, {
        status: writesEvent ? 'reconciled' : 'released',
        actualUsd: writesEvent ? microsToUsd(amount).toFixed(6) : null,
        reconciledAt: now,
      });
      tx.set(refs.holds, { heldMicros: held - estimated });
      if (refs.taskHolds) tx.set(refs.taskHolds, { heldMicros: taskHeld - estimated });
    } else {
      // Direct spend and reservations contend on this same document.
      tx.set(refs.holds, { heldMicros: held });
    }
    if (writesEvent) {
      tx.set(refs.daily, { spentMicros: addMicros(integer(daily, 'spentMicros'), amount) });
      tx.set(refs.monthly, { spentMicros: addMicros(integer(monthly, 'spentMicros'), amount) });
      if (shouldAddTaskSpend && refs.task) {
        tx.update(refs.task, {
          spentUsd: microsToUsd(addMicros(taskSpent, amount)).toFixed(6),
          updatedAt: now,
        });
      }
      const details = actual ?? direct;
      tx.create(
        eventRef,
        encodeRecord({
          id: eventId,
          source: reservation?.get('source') ?? direct?.source,
          taskId,
          toolCallId: details?.toolCallId ?? null,
          reservationId,
          usd: microsToUsd(amount).toFixed(6),
          quantity: details?.quantity?.toFixed(4) ?? null,
          unit: details?.unit ?? null,
          unitPriceUsd: details?.unitPriceUsd?.toFixed(8) ?? null,
          description: details?.description ?? reservation?.get('description') ?? '',
          createdAt: now,
        }),
      );
    }
    return true;
  }

  async record(input: CostEventInput): Promise<void> {
    if (input.reservationId) throw new Error('Use reconcile to settle a reservation');
    const id = randomUUID();
    await this.store.db.runTransaction((tx) => this.settle(tx, null, null, input, id));
  }

  async reconcile(reservationId: string, actual: ReservationActual): Promise<void> {
    usdToMicros(actual.usd);
    const id = randomUUID();
    await this.store.db.runTransaction((tx) =>
      this.settle(tx, reservationId, actual, undefined, id),
    );
  }

  async release(reservationId: string): Promise<void> {
    await this.store.db.runTransaction((tx) => this.settle(tx, reservationId, null));
  }

  async releaseStale(olderThanMinutes = 120, batch = 500): Promise<number> {
    if (
      !Number.isFinite(olderThanMinutes) ||
      olderThanMinutes <= 0 ||
      !Number.isInteger(batch) ||
      batch < 1 ||
      batch > 500
    ) {
      throw new Error('Invalid reservation cleanup bounds');
    }
    const cutoff = new Date(this.store.now().getTime() - olderThanMinutes * 60_000);
    const stale = await this.store
      .collection('costReservations')
      .where('status', '==', 'held')
      .where('createdAt', '<', cutoff)
      .orderBy('createdAt')
      .limit(batch)
      .get();
    let released = 0;
    for (const doc of stale.docs) {
      if (
        await this.store.db.runTransaction((tx) =>
          this.settle(tx, doc.get('id'), null, undefined, undefined, cutoff),
        )
      )
        released++;
    }
    return released;
  }
}
