'use client';

import { useState, useTransition } from 'react';
import {
  addOccasionAction,
  forgetOccasionAction,
  reviewOccasionAction,
} from '@/app/profile/actions';
import {
  Badge,
  btn,
  btnSm,
  EmptyState,
  inputClass,
  labelClass,
  SectionHeading,
  selectClass,
} from '@/lib/ui';

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

/** A date found in a saved fact that isn't yet an occasion (the chip source). */
export interface OccasionSuggestion {
  kind: 'birthday' | 'anniversary';
  month: number;
  day: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

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
  suggestions = [],
}: {
  contactId: string;
  personName: string;
  occasions: OccasionView[];
  suggestions?: OccasionSuggestion[];
}) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const saveSuggestion = (suggestion: OccasionSuggestion) => {
    const key = `${suggestion.month}-${suggestion.day}`;
    startTransition(async () => {
      setError(null);
      const result = await addOccasionAction(contactId, {
        kind: suggestion.kind,
        label: '',
        month: String(suggestion.month),
        day: String(suggestion.day),
        year: '',
        leadDays: '7',
        notes: '',
      });
      if (result.error) setError(result.error);
      else setDismissed((prev) => new Set(prev).add(key));
    });
  };

  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(`${s.month}-${s.day}`));

  return (
    <section className="mt-8">
      <SectionHeading title="Occasions" count={occasions.length} />
      <p className="mt-1 text-xs text-muted">
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
                  : 'border-edge'
              }`}
            >
              <span className="text-sm font-medium capitalize">{kindLabel(o)}</span>
              <span className="text-sm text-muted">{dateLabel(o)}</span>
              {o.notes ? <span className="text-xs text-muted">— {o.notes}</span> : null}
              {o.quarantined ? (
                <Badge tone="amber" size="xs">
                  Unverified
                </Badge>
              ) : null}
              <span className="ml-auto flex gap-2">
                {o.quarantined ? (
                  <>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => startTransition(() => reviewOccasionAction(o.id, 'approve'))}
                      className={btnSm.outline}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => startTransition(() => reviewOccasionAction(o.id, 'reject'))}
                      className={btnSm.dangerOutline}
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => startTransition(() => forgetOccasionAction(o.id))}
                    className={btnSm.dangerOutline}
                  >
                    Forget
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState>No occasions saved for {personName} yet.</EmptyState>
      )}

      {visibleSuggestions.length > 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-edge bg-sunken/40 p-3">
          <p className="text-xs text-muted">
            Found in saved facts — save any of these as a recurring reminder:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {visibleSuggestions.map((s) => (
              <button
                key={`${s.month}-${s.day}-${s.kind}`}
                type="button"
                disabled={pending}
                onClick={() => saveSuggestion(s)}
                className={`${btn.outline} gap-1`}
                title={`Save ${MONTHS_LONG[s.month - 1]} ${s.day} as ${s.kind === 'birthday' ? 'a birthday' : 'an anniversary'}`}
              >
                + {MONTHS_LONG[s.month - 1]} {s.day}
                <span className="text-muted">· {s.kind}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {adding ? (
        <form
          className="mt-3 flex flex-col gap-3 rounded-2xl bg-sunken/55 p-4"
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
              <select name="kind" defaultValue="birthday" className={selectClass}>
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
