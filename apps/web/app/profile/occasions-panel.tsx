'use client';

import { useState, useTransition } from 'react';
import {
  addOccasionAction,
  forgetOccasionAction,
  reviewOccasionAction,
} from '@/app/profile/actions';
import { btn, inputClass, labelClass } from '@/lib/ui';

/** Plain-serializable occasion view built in the page. */
export interface OccasionView {
  id: string;
  kind: string;
  label: string;
  month: number;
  day: number;
  year: number | null;
  notes: string;
  quarantined: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateLabel(o: OccasionView): string {
  const md = `${MONTHS[o.month - 1] ?? o.month} ${o.day}`;
  return o.year ? `${md}, ${o.year}` : md;
}

function kindLabel(o: OccasionView): string {
  if (o.kind === 'custom') return o.label || 'occasion';
  return o.kind;
}

export function OccasionsPanel({
  contactId,
  personName,
  occasions,
}: {
  contactId: string;
  personName: string;
  occasions: OccasionView[];
}) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="mt-8">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        Occasions
        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {occasions.length}
        </span>
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        Birthdays, anniversaries, and other recurring dates. The assistant reminds you at lead time
        in your morning brief.
      </p>

      {occasions.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {occasions.map((o) => (
            <div
              key={o.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 ${
                o.quarantined
                  ? 'border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'
                  : 'border-zinc-200 dark:border-zinc-800'
              }`}
            >
              <span className="text-sm font-medium capitalize">{kindLabel(o)}</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">{dateLabel(o)}</span>
              {o.notes ? (
                <span className="text-xs text-zinc-500 dark:text-zinc-500">— {o.notes}</span>
              ) : null}
              {o.quarantined ? (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  unverified
                </span>
              ) : null}
              <span className="ml-auto flex gap-2">
                {o.quarantined ? (
                  <>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => startTransition(() => reviewOccasionAction(o.id, 'approve'))}
                      className={btn.outline}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => startTransition(() => reviewOccasionAction(o.id, 'reject'))}
                      className={btn.dangerOutline}
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => startTransition(() => forgetOccasionAction(o.id))}
                    className={btn.dangerOutline}
                  >
                    Forget
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          No occasions saved for {personName} yet.
        </p>
      )}

      {adding ? (
        <form
          className="mt-3 flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
          action={(formData) =>
            startTransition(async () => {
              setError(null);
              const result = await addOccasionAction(contactId, {
                kind: String(formData.get('kind') ?? ''),
                label: String(formData.get('label') ?? ''),
                month: String(formData.get('month') ?? ''),
                day: String(formData.get('day') ?? ''),
                year: String(formData.get('year') ?? ''),
                leadDays: String(formData.get('leadDays') ?? ''),
                notes: String(formData.get('notes') ?? ''),
              });
              if (result.error) setError(result.error);
              else setAdding(false);
            })
          }
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Type
              <select name="kind" defaultValue="birthday" className={inputClass}>
                <option value="birthday">Birthday</option>
                <option value="anniversary">Anniversary</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Label (if custom)
              <input
                name="label"
                type="text"
                placeholder="e.g. graduation"
                className={`${inputClass} w-40`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Month
              <input
                name="month"
                type="number"
                min={1}
                max={12}
                required
                className={`${inputClass} w-20`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Day
              <input
                name="day"
                type="number"
                min={1}
                max={31}
                required
                className={`${inputClass} w-20`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Year (optional)
              <input
                name="year"
                type="number"
                min={1900}
                max={2200}
                className={`${inputClass} w-24`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Remind (days before)
              <input
                name="leadDays"
                type="number"
                min={0}
                max={60}
                defaultValue={7}
                className={`${inputClass} w-24`}
              />
            </label>
          </div>
          <label className={`flex flex-col gap-1 ${labelClass}`}>
            Notes / gift ideas (optional)
            <input name="notes" type="text" className={inputClass} />
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={pending} className={btn.primary}>
              Save occasion
            </button>
            <button type="button" onClick={() => setAdding(false)} className={btn.outline}>
              Cancel
            </button>
            {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${btn.outline} mt-3`}>
          Add occasion
        </button>
      )}
    </section>
  );
}
