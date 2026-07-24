'use client';

import { useState, useTransition } from 'react';
import {
  addSkillAction,
  deleteSkillAction,
  editSkillAction,
  toggleSkillDeprecatedAction,
} from '@/app/skills/actions';
import {
  Badge,
  btn,
  CountBadge,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  InfoGrid,
  InfoItem,
  inputClass as sharedInputClass,
  textareaClass as sharedTextareaClass,
} from '@/lib/ui';

export interface SkillView {
  id: string;
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
  ownerAuthored: boolean;
  deprecated: boolean;
  useCount: number;
  successCount: number;
  failureCount: number;
  createdLabel: string;
}

const inputClass = `${sharedInputClass} w-full`;

function SkillForm({
  initial,
  submitting,
  onSubmit,
  onCancel,
  error,
}: {
  initial?: Partial<SkillView>;
  submitting: boolean;
  onSubmit: (fd: FormData) => void;
  onCancel?: () => void;
  error?: string | null;
}) {
  return (
    <form action={onSubmit} className="flex flex-col gap-2">
      <input
        name="name"
        defaultValue={initial?.name ?? ''}
        placeholder="Name (e.g. Booking flights)"
        required
        className={`${sharedTextareaClass} w-full`}
      />
      <input
        name="preconditions"
        defaultValue={initial?.preconditions ?? ''}
        placeholder="When it applies (optional)"
        className={inputClass}
      />
      <textarea
        name="steps"
        defaultValue={initial?.steps ?? ''}
        placeholder="Steps — the procedure, in plain language"
        required
        rows={3}
        className={inputClass}
      />
      <input
        name="gotchas"
        defaultValue={initial?.gotchas ?? ''}
        placeholder="Gotchas (optional)"
        className={inputClass}
      />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={submitting} className={btn.primary}>
          Save skill
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className={btn.outline}>
            Cancel
          </button>
        ) : null}
        {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </form>
  );
}

export function SkillsPanel({ skills }: { skills: SkillView[] }) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A skill is owner-authored prose; deleting it is not recoverable. Two-step
  // like every other destructive control (documents, memory, stop goal).
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const fields = (fd: FormData) => ({
    name: String(fd.get('name') ?? ''),
    preconditions: String(fd.get('preconditions') ?? ''),
    steps: String(fd.get('steps') ?? ''),
    gotchas: String(fd.get('gotchas') ?? ''),
  });

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          Skills
          <CountBadge>{skills.length}</CountBadge>
        </h2>
        {!adding ? (
          <button type="button" onClick={() => setAdding(true)} className={btn.outline}>
            Add skill
          </button>
        ) : null}
      </div>

      {adding ? (
        <div className={`${cardShellClass} mt-3 p-4`}>
          <SkillForm
            submitting={pending}
            error={error}
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
            onSubmit={(fd) =>
              startTransition(async () => {
                setError(null);
                const result = await addSkillAction(fields(fd));
                if (result.error) setError(result.error);
                else setAdding(false);
              })
            }
          />
        </div>
      ) : null}

      {skills.length === 0 && !adding ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          No skills yet — the assistant drafts these from tasks it solves a non-obvious way, and you
          can add your own.
        </p>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {skills.map((s) => (
            <article
              key={s.id}
              className={`${cardShellClass} flex h-full flex-col ${s.deprecated ? 'opacity-60' : ''}`}
            >
              {editingId === s.id ? (
                <div className={cardBodyClass}>
                  <SkillForm
                    initial={s}
                    submitting={pending}
                    error={error}
                    onCancel={() => {
                      setEditingId(null);
                      setError(null);
                    }}
                    onSubmit={(fd) =>
                      startTransition(async () => {
                        setError(null);
                        const result = await editSkillAction(s.id, fields(fd));
                        if (result.error) setError(result.error);
                        else setEditingId(null);
                      })
                    }
                  />
                </div>
              ) : (
                <>
                  <div className={`${cardBodyClass} flex-1`}>
                    <div className={cardHeaderClass}>
                      <div className="min-w-0">
                        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{s.name}</h3>
                        <p className="mt-0.5 text-xs text-muted">
                          {s.ownerAuthored ? 'Written by you' : 'Learned from completed work'}
                        </p>
                      </div>
                      {s.deprecated ? (
                        <Badge tone="amber">Retired</Badge>
                      ) : (
                        <Badge tone="green">Active</Badge>
                      )}
                    </div>
                    <section>
                      <h4 className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
                        How it works
                      </h4>
                      <p className="mt-1 text-[13px] leading-5 whitespace-pre-wrap text-strong">
                        {s.steps}
                      </p>
                    </section>
                    {s.preconditions || s.gotchas ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {s.preconditions ? (
                          <section className="rounded-xl bg-sunken/65 px-3 py-2.5">
                            <h4 className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
                              When to use it
                            </h4>
                            <p className="mt-1 text-xs leading-5 text-strong">{s.preconditions}</p>
                          </section>
                        ) : null}
                        {s.gotchas ? (
                          <section className="rounded-xl bg-amber-50 px-3 py-2.5 dark:bg-amber-950/25">
                            <h4 className="text-2xs font-semibold tracking-[0.08em] text-amber-800 uppercase dark:text-amber-300">
                              Watch for
                            </h4>
                            <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-200">
                              {s.gotchas}
                            </p>
                          </section>
                        ) : null}
                      </div>
                    ) : null}
                    <InfoGrid className="sm:grid-cols-4">
                      <InfoItem label="Used">{s.useCount}</InfoItem>
                      <InfoItem label="Succeeded">{s.successCount}</InfoItem>
                      <InfoItem label="Failed">{s.failureCount}</InfoItem>
                      <InfoItem label="Added">{s.createdLabel}</InfoItem>
                    </InfoGrid>
                  </div>
                  <footer className={cardFooterClass}>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(s.id);
                        setError(null);
                      }}
                      className={btn.outline}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        startTransition(() => toggleSkillDeprecatedAction(s.id, !s.deprecated))
                      }
                      className={btn.outline}
                    >
                      {s.deprecated ? 'Restore' : 'Retire'}
                    </button>
                    {confirmingDeleteId === s.id ? (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              await deleteSkillAction(s.id);
                              setConfirmingDeleteId(null);
                            })
                          }
                          className={btn.danger}
                        >
                          {pending ? 'Deleting…' : 'Confirm delete'}
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setConfirmingDeleteId(null)}
                          className={btn.outline}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => setConfirmingDeleteId(s.id)}
                        className={btn.dangerOutline}
                      >
                        Delete
                      </button>
                    )}
                  </footer>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
