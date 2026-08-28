'use client';

import type { KnowledgeGraphEntityView } from '@assistant/application';
import { Check, Plus, Search } from 'lucide-react';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import {
  type AddKnowledgeRelationState,
  addKnowledgeRelation,
  searchKnowledgeEntities,
} from '@/app/profile/knowledge/actions';
import { ENTITY_KINDS, entityKindLabel, predicateSuggestions } from '@/lib/knowledge';
import { btn, btnSm, inputClass, labelClass, selectClass, textareaClass } from '@/lib/ui';

const initialState: AddKnowledgeRelationState = { error: null, success: null };

function EntityKindOptions() {
  return ENTITY_KINDS.map((value) => (
    <option key={value} value={value}>
      {entityKindLabel(value)}
    </option>
  ));
}

type DatePrecision = 'day' | 'month' | 'recurring';

/** Month values for the recurring-date picker; keys come from the value itself. */
const MONTH_VALUES = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));

/**
 * The date endpoint: structured inputs producing a canonical string
 * (YYYY-MM-DD, YYYY-MM, or --MM-DD), replacing the free-form label that used
 * to round-trip through the canonicalizer and could be rejected as unreadable.
 * What you pick is what the graph stores — no interpretation step.
 */
function DateValueInput({ name }: { name: string }) {
  const [precision, setPrecision] = useState<DatePrecision>('day');
  const [recurringMonth, setRecurringMonth] = useState('01');
  const [recurringDay, setRecurringDay] = useState('1');
  return (
    <div className="grid gap-1.5">
      <div className="flex gap-1">
        {(
          [
            ['day', 'Specific day'],
            ['month', 'Month'],
            ['recurring', 'Every year'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setPrecision(value)}
            aria-pressed={precision === value}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium motion-safe:transition-colors ${
              precision === value
                ? 'bg-raised text-accent ring-1 ring-accent/25'
                : 'text-muted hover:bg-raised hover:text-strong'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {precision === 'day' ? (
        <input type="date" name={name} required className={inputClass} />
      ) : null}
      {precision === 'month' ? (
        <input type="month" name={name} required className={inputClass} />
      ) : null}
      {precision === 'recurring' ? (
        <div className="flex items-center gap-2">
          <input
            type="hidden"
            name={name}
            value={`--${recurringMonth}-${recurringDay.padStart(2, '0')}`}
          />
          <select
            aria-label="Month"
            value={recurringMonth}
            onChange={(event) => setRecurringMonth(event.target.value)}
            className={selectClass}
          >
            {MONTH_VALUES.map((value) => (
              <option key={value} value={value}>
                {new Intl.DateTimeFormat('en', { month: 'long' }).format(
                  new Date(Date.UTC(2024, Number(value) - 1, 1)),
                )}
              </option>
            ))}
          </select>
          <input
            type="number"
            aria-label="Day of month"
            min={1}
            max={31}
            value={recurringDay}
            onChange={(event) => setRecurringDay(event.target.value)}
            className={`${inputClass} w-20`}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One endpoint of the new relationship. Kind drives the value control: dates
 * get structured inputs, every other kind gets a type-ahead over existing
 * entities so linking never retypes (or duplicates) a name — typing a name
 * that matches nothing creates it, which the hint says out loud.
 */
function EndpointPicker({
  name,
  legend,
  kind,
  onKindChange,
  prefill,
  placeholder,
}: {
  name: 'subject' | 'object';
  legend: string;
  kind: string;
  onKindChange: (kind: string) => void;
  prefill?: KnowledgeGraphEntityView | null;
  placeholder: string;
}) {
  const [picked, setPicked] = useState<KnowledgeGraphEntityView | null>(prefill ?? null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeGraphEntityView[]>([]);
  const [searching, startSearch] = useTransition();
  // Guards against an earlier, slower search landing after a later one and
  // overwriting the results the typed query actually asked for.
  const requestRef = useRef(0);

  useEffect(() => {
    if (kind === 'date') return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const token = ++requestRef.current;
    const timer = setTimeout(() => {
      startSearch(async () => {
        const rows = await searchKnowledgeEntities(trimmed, '', kind);
        if (requestRef.current === token) setResults(rows);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, kind]);

  // Changing kind invalidates both the pick and the search context.
  const handleKindChange = (next: string) => {
    setPicked(null);
    setQuery('');
    setResults([]);
    onKindChange(next);
  };

  const trimmed = query.trim();
  const exactMatch = results.some(
    (row) => row.label.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );

  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-1">
        <label className={labelClass} htmlFor={`${name}-kind`}>
          {legend} type
        </label>
        <select
          id={`${name}-kind`}
          name={`${name}Kind`}
          value={kind}
          onChange={(event) => handleKindChange(event.target.value)}
          className={selectClass}
        >
          <EntityKindOptions />
        </select>
      </div>

      <input type="hidden" name={`${name}Id`} value={picked?.id ?? ''} />

      {kind === 'date' ? (
        <div className="grid gap-1">
          <span className={labelClass}>{legend} date</span>
          <DateValueInput name={`${name}Label`} />
        </div>
      ) : picked ? (
        <div className="grid gap-1">
          <span className={labelClass}>{legend}</span>
          <input type="hidden" name={`${name}Label`} value={picked.label} />
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2">
            <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={picked.label}>
              {picked.label}
            </span>
            <span className="shrink-0 text-xs text-muted">{entityKindLabel(picked.kind)}</span>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="shrink-0 text-xs font-medium text-muted underline underline-offset-2 hover:text-strong"
            >
              Change
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-1">
          <label className={`relative block ${labelClass}`}>
            {legend}
            <span className="relative mt-1 block">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                type="text"
                name={`${name}Label`}
                required
                minLength={1}
                maxLength={160}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={placeholder}
                autoComplete="off"
                className={`${inputClass} w-full pl-9 font-normal`}
              />
            </span>
          </label>
          {trimmed.length >= 2 ? (
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-edge bg-raised">
              {results.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted">
                  {searching ? 'Searching…' : 'No existing items match.'}
                </li>
              ) : (
                results.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPicked(option);
                        setQuery('');
                        setResults([]);
                      }}
                      className="flex w-full min-w-0 items-baseline justify-between gap-2 px-3 py-2 text-left text-sm motion-safe:transition-colors hover:bg-sunken"
                    >
                      <span className="min-w-0 truncate" title={option.label}>
                        {option.label}
                      </span>
                      <span className="shrink-0 text-xs text-muted">
                        {entityKindLabel(option.kind)}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
          {trimmed.length >= 2 && !exactMatch ? (
            <p className="text-xs leading-5 text-muted">
              No exact match — “{trimmed}” will be created as a new{' '}
              {entityKindLabel(kind).toLocaleLowerCase()}.
            </p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

/**
 * The form intentionally requires a note. A manual edge is written as a
 * durable owner memory first, rather than becoming an unexplained graph row.
 */
export function AddKnowledgeRelation({ selected }: { selected: KnowledgeGraphEntityView | null }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(addKnowledgeRelation, initialState);
  const [subjectKind, setSubjectKind] = useState(selected?.kind ?? 'person');
  const [objectKind, setObjectKind] = useState('organization');
  const suggestions = predicateSuggestions(subjectKind, objectKind);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={btnSm.outline}>
        <Plus className="size-3.5" aria-hidden="true" />
        Add relationship
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="mt-4 grid gap-3 rounded-xl border border-edge bg-sunken/35 p-4"
    >
      <p className="text-sm leading-5 text-muted">
        This saves your note as the evidence behind the relationship. It is never an unsupported
        graph-only fact.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <EndpointPicker
          name="subject"
          legend="From"
          kind={subjectKind}
          onKindChange={setSubjectKind}
          prefill={selected}
          placeholder="Search or create…"
        />
        <EndpointPicker
          name="object"
          legend="To"
          kind={objectKind}
          onKindChange={setObjectKind}
          placeholder="Search or create…"
        />
      </div>
      <label className={`grid gap-1 ${labelClass}`}>
        Relationship
        <input
          name="predicate"
          required
          minLength={1}
          maxLength={80}
          list="knowledge-predicate-suggestions"
          placeholder={suggestions[0] ? `e.g. ${suggestions[0].replaceAll('_', ' ')}` : 'works at'}
          autoComplete="off"
          className={inputClass}
        />
        <datalist id="knowledge-predicate-suggestions">
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        <span className="text-xs leading-5 font-normal text-muted">
          Suggestions follow the {entityKindLabel(subjectKind).toLocaleLowerCase()} →{' '}
          {entityKindLabel(objectKind).toLocaleLowerCase()} direction; you can always type your own.
        </span>
      </label>
      <label className={`grid gap-1 ${labelClass}`}>
        Your source note
        <textarea
          name="note"
          required
          minLength={3}
          maxLength={1000}
          rows={2}
          placeholder="Why this is true, or where you learned it…"
          className={textareaClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={btn.primary}>
          {pending ? 'Saving…' : 'Save relationship'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={btn.outline}>
          Cancel
        </button>
        {state.error ? (
          <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>
        ) : null}
        {state.success ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">{state.success}</p>
        ) : null}
      </div>
    </form>
  );
}
