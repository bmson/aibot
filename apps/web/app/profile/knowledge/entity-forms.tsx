'use client';

import type { KnowledgeGraphDuplicate, KnowledgeGraphEntityView } from '@assistant/application';
import { ArrowRightLeft, Check, Search } from 'lucide-react';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import {
  type KnowledgeActionState,
  mergeKnowledgeEntity,
  renameKnowledgeEntity,
  searchKnowledgeEntities,
} from '@/app/profile/knowledge/actions';
import { entityKindLabel } from '@/lib/knowledge';
import { btnSm, inputClass, labelClass } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

const initialState: KnowledgeActionState = { error: null, success: null };

function ActionMessage({ state }: { state: KnowledgeActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-xs text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">
        {state.success}
      </p>
    );
  }
  return null;
}

export function RenameEntity({ entity }: { entity: KnowledgeGraphEntityView }) {
  const [state, formAction] = useActionState(
    renameKnowledgeEntity.bind(null, entity.id),
    initialState,
  );
  return (
    <form action={formAction} className="grid gap-2">
      <label className={`grid gap-1 ${labelClass}`}>
        Display name
        <input
          name="label"
          required
          minLength={1}
          maxLength={160}
          defaultValue={entity.label}
          className={inputClass}
        />
      </label>
      <p className="text-xs leading-5 text-muted">
        Changes what you see. The extraction identity behind it stays the same, so future syncs
        still land on this item.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" pendingLabel="Saving…">
          Rename display
        </SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

/**
 * Merge target picker. The old control was a `<select>` holding the first 200
 * entities alphabetically, which made anything past that point unreachable and
 * gave no way to search. This queries on demand instead, so the reachable set is
 * the whole graph, and it leads with the same-kind duplicates the server already
 * spotted — merging a person into a date is nearly always a slip.
 */
export function MergeEntity({
  entity,
  duplicates,
}: {
  entity: KnowledgeGraphEntityView;
  duplicates: KnowledgeGraphDuplicate[];
}) {
  const [state, formAction] = useActionState(
    mergeKnowledgeEntity.bind(null, entity.id),
    initialState,
  );
  const [query, setQuery] = useState('');
  const [sameKindOnly, setSameKindOnly] = useState(true);
  const [results, setResults] = useState<KnowledgeGraphEntityView[]>([]);
  const [target, setTarget] = useState<{ id: string; label: string; kind: string } | null>(null);
  const [searching, startSearch] = useTransition();
  // Guards against an earlier, slower search landing after a later one and
  // overwriting the results the typed query actually asked for.
  const requestRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const token = ++requestRef.current;
    const timer = setTimeout(() => {
      startSearch(async () => {
        const rows = await searchKnowledgeEntities(
          trimmed,
          entity.id,
          sameKindOnly ? entity.kind : '',
        );
        if (requestRef.current === token) setResults(rows);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, sameKindOnly, entity.id, entity.kind]);

  const choose = (option: { id: string; label: string; kind: string }) => {
    setTarget(option);
    setQuery('');
    setResults([]);
  };

  return (
    <form action={formAction} className="grid gap-2">
      <span className={labelClass}>Merge this into</span>
      <input type="hidden" name="targetId" value={target?.id ?? ''} />

      {duplicates.length > 0 && !target ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Possible duplicates:</span>
          {duplicates.map((duplicate) => (
            <button
              key={duplicate.targetId}
              type="button"
              onClick={() =>
                choose({
                  id: duplicate.targetId,
                  label: duplicate.label,
                  kind: duplicate.kind,
                })
              }
              title={`Possible duplicate: ${duplicate.reason}`}
              className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 motion-safe:transition-colors hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
            >
              {duplicate.label}
            </button>
          ))}
        </div>
      ) : null}

      {target ? (
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2">
          <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={target.label}>
            {target.label}
          </span>
          <span className="shrink-0 text-xs text-muted">{entityKindLabel(target.kind)}</span>
          <button
            type="button"
            onClick={() => setTarget(null)}
            className="shrink-0 text-xs font-medium text-muted underline underline-offset-2 hover:text-strong"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="grid gap-1.5">
          <label className="relative block">
            <span className="sr-only">Search for an item to merge into</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name…"
              className={`${inputClass} w-full pl-9`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={sameKindOnly}
              onChange={(event) => setSameKindOnly(event.target.checked)}
              className="size-3.5"
            />
            Only {entityKindLabel(entity.kind).toLocaleLowerCase()} items
          </label>
          {query.trim().length >= 2 ? (
            <ul className="max-h-48 overflow-y-auto rounded-lg border border-edge bg-raised">
              {results.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted">
                  {searching ? 'Searching…' : 'No matching items.'}
                </li>
              ) : (
                results.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => choose(option)}
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
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <MergeSubmit disabled={!target} targetLabel={target?.label ?? ''} />
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

/**
 * Two-step confirm, matching the ConfirmButton pattern elsewhere, but spelled
 * out here so the confirmation can name the target — a merge is not reversible
 * from this page, and "Merge items?" alone does not say into what.
 */
function MergeSubmit({ disabled, targetLabel }: { disabled: boolean; targetLabel: string }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (disabled) setConfirming(false);
  }, [disabled]);

  if (!confirming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
        className={btnSm.outline}
        title="Preserves all sources and routes future extractions to the remaining item."
      >
        <ArrowRightLeft className="size-3.5" aria-hidden="true" />
        Merge entity
      </button>
    );
  }
  return (
    <SubmitButton size="sm" variant="danger" pendingLabel="Merging…">
      Merge into {targetLabel}?
    </SubmitButton>
  );
}
