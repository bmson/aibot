'use client';

import type {
  KnowledgeGraphEntityView,
  KnowledgeGraphRelationView,
  PredicateSpec,
} from '@assistant/application';
import { presentKnowledgeGraphRelation } from '@assistant/application/relationship-presentation';
import { Check, Plus, Search } from 'lucide-react';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import {
  type AddKnowledgeRelationState,
  addKnowledgeRelation,
  correctKnowledgeRelation,
  searchKnowledgeEntities,
} from '@/app/profile/knowledge/actions';
import { ENTITY_KINDS, entityKindLabel, PREDICATE_FALLBACK_SUGGESTIONS } from '@/lib/knowledge';
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
  onValueChange,
}: {
  name: 'subject' | 'object';
  legend: string;
  kind: string;
  onKindChange: (kind: string) => void;
  prefill?: KnowledgeGraphEntityView | null;
  placeholder: string;
  onValueChange?: (value: { label: string; kind: string }) => void;
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

  useEffect(() => {
    onValueChange?.({ label: picked?.label ?? query, kind });
  }, [kind, onValueChange, picked?.label, query]);

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

function predicatePhrase(predicate: string): string {
  const label = predicate.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
  if (label.endsWith(' of')) return `is the ${label}`;
  if (label === 'employs') return 'employs';
  if (label === 'attended by') return 'was attended by';
  return label;
}

function connectionSentence(subject: string, predicate: string, object: string): string {
  return presentKnowledgeGraphRelation({
    subjectLabel: subject.trim() || 'First item',
    predicate,
    objectLabel: object.trim() || 'connected item',
  }).sentence;
}

/**
 * The form intentionally requires a note. A manual edge is written as a
 * durable owner memory first, rather than becoming an unexplained graph row.
 *
 * The predicate vocabulary arrives as props from the server page: the typed
 * registry lives in core, and a client component must not import it.
 */
export function AddKnowledgeRelation({
  selected,
  vocabulary,
  correction,
}: {
  selected: KnowledgeGraphEntityView | null;
  vocabulary: readonly PredicateSpec[];
  correction?: KnowledgeGraphRelationView;
}) {
  const [open, setOpen] = useState(false);
  const action = correction
    ? correctKnowledgeRelation.bind(null, correction.id)
    : addKnowledgeRelation;
  const [state, formAction, pending] = useActionState(action, initialState);
  const [subjectKind, setSubjectKind] = useState(
    correction?.subject.kind ?? selected?.kind ?? 'person',
  );
  const [objectKind, setObjectKind] = useState(correction?.object.kind ?? 'organization');
  const [subjectValue, setSubjectValue] = useState(
    correction?.subject.label ?? selected?.label ?? '',
  );
  const [objectValue, setObjectValue] = useState(correction?.object.label ?? '');
  const [predicate, setPredicate] = useState(correction?.predicate ?? '');
  const [customPredicate, setCustomPredicate] = useState('');
  const typed = vocabulary
    .filter(
      (spec) =>
        (spec.subjectKinds as readonly string[]).includes(subjectKind) &&
        (spec.objectKinds as readonly string[]).includes(objectKind),
    )
    .map((spec) => spec.id);
  const suggestions = typed.length > 0 ? typed : PREDICATE_FALLBACK_SUGGESTIONS;
  const chosenPredicate =
    predicate === '__custom' ? customPredicate : predicate || suggestions[0] || '';

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={btnSm.outline}>
        <Plus className="size-3.5" aria-hidden="true" />
        {correction ? 'Correct connection' : 'Add connection'}
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="fixed inset-0 z-50 grid place-items-end bg-strong/25 p-0 sm:place-items-center sm:p-6"
    >
      <div className="grid max-h-[92dvh] w-full max-w-2xl gap-4 overflow-y-auto rounded-t-2xl bg-raised p-5 shadow-2xl sm:rounded-2xl sm:p-6">
        <div>
          <p className="font-display text-xl font-semibold text-strong">
            {correction ? 'Correct connection' : 'Add a connection'}
          </p>
          <p className="mt-1 text-sm leading-5 text-muted">
            {correction
              ? 'Save the corrected fact first. The earlier connection will remain as evidence but stop being used.'
              : 'Save a relationship the assistant can understand and trace back to your note.'}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <EndpointPicker
            name="subject"
            legend="First item"
            kind={subjectKind}
            onKindChange={setSubjectKind}
            prefill={correction?.subject ?? selected}
            placeholder="Search or create…"
            onValueChange={(value) => setSubjectValue(value.label)}
          />
          <EndpointPicker
            name="object"
            legend="Connected item"
            kind={objectKind}
            onKindChange={setObjectKind}
            prefill={correction?.object}
            placeholder="Search or create…"
            onValueChange={(value) => setObjectValue(value.label)}
          />
        </div>
        <label className={`grid gap-1 ${labelClass}`}>
          Relationship
          <select
            value={predicate || suggestions[0] || ''}
            onChange={(event) => setPredicate(event.target.value)}
            className={selectClass}
          >
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion}>
                {predicatePhrase(suggestion)}
              </option>
            ))}
            <option value="__custom">Use my own words…</option>
          </select>
          {predicate === '__custom' ? (
            <input
              value={customPredicate}
              onChange={(event) => setCustomPredicate(event.target.value)}
              required
              minLength={1}
              maxLength={80}
              placeholder="e.g. advises"
              className={inputClass}
            />
          ) : null}
          <input type="hidden" name="predicate" value={chosenPredicate} />
        </label>
        <div className="rounded-xl border border-accent/25 bg-sunken/55 p-3">
          <p className="text-xs font-medium tracking-[0.08em] text-muted uppercase">
            This will say
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-strong">
            {connectionSentence(subjectValue, chosenPredicate, objectValue)}
          </p>
        </div>
        <label className={`grid gap-1 ${labelClass}`}>
          Your source note
          <textarea
            name="note"
            required
            minLength={3}
            maxLength={1000}
            rows={3}
            placeholder="Why this is true, or where you learned it…"
            className={textareaClass}
          />
          <span className="text-xs leading-5 font-normal text-muted">
            This note is the evidence behind the connection, never an unsupported graph-only fact.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={pending || !chosenPredicate.trim()}
            className={btn.primary}
          >
            {pending ? 'Saving…' : correction ? 'Save corrected connection' : 'Save connection'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className={btn.outline}>
            Cancel
          </button>
          {state.error ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}
          {state.success ? (
            <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">
              {state.success}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
