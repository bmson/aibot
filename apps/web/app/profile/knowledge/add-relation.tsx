'use client';

import type { KnowledgeGraphEntityView } from '@assistant/application';
import { Plus } from 'lucide-react';
import { useActionState, useState } from 'react';
import {
  type AddKnowledgeRelationState,
  addKnowledgeRelation,
} from '@/app/profile/knowledge/actions';
import { ENTITY_KINDS, entityKindLabel } from '@/lib/knowledge';
import { btn, btnSm, inputClass, labelClass, selectClass, textareaClass } from '@/lib/ui';

const initialState: AddKnowledgeRelationState = { error: null, success: null };

function EntityKindOptions() {
  return ENTITY_KINDS.map((value) => (
    <option key={value} value={value}>
      {entityKindLabel(value)}
    </option>
  ));
}

/**
 * The form intentionally requires a note. A manual edge is written as a
 * durable owner memory first, rather than becoming an unexplained graph row.
 */
export function AddKnowledgeRelation({ selected }: { selected: KnowledgeGraphEntityView | null }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(addKnowledgeRelation, initialState);
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
        <label className={`grid gap-1 ${labelClass}`}>
          From
          <input
            name="subjectLabel"
            required
            minLength={1}
            maxLength={160}
            defaultValue={selected?.label ?? ''}
            placeholder="e.g. Ada Lovelace"
            className={inputClass}
          />
        </label>
        <label className={`grid gap-1 ${labelClass}`}>
          Type
          <select
            name="subjectKind"
            defaultValue={selected?.kind ?? 'person'}
            className={selectClass}
          >
            <EntityKindOptions />
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <label className={`grid gap-1 ${labelClass}`}>
          Relationship
          <input
            name="predicate"
            required
            minLength={1}
            maxLength={80}
            placeholder="works at"
            className={inputClass}
          />
        </label>
        <label className={`grid gap-1 ${labelClass}`}>
          To
          <input
            name="objectLabel"
            required
            minLength={1}
            maxLength={160}
            placeholder="e.g. Analytical Engine"
            className={inputClass}
          />
        </label>
        <label className={`grid gap-1 ${labelClass}`}>
          Type
          <select name="objectKind" defaultValue="organization" className={selectClass}>
            <EntityKindOptions />
          </select>
        </label>
      </div>
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
