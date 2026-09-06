'use client';

import type {
  PackCommand,
  SituationPackView,
  SituationPreview,
  SituationResult,
} from '@assistant/application/situations';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { btnSm, inputClass, selectClass, textareaClass } from '@/lib/ui';

type Source = {
  id: string;
  title: string;
  kind: 'card' | 'commitment';
  lane: 'plan' | 'i_owe' | 'waiting_on';
};
type Overview = { packs: SituationPackView[]; sources: Source[] };
type Item = SituationPackView['data']['items'][number];
const laneNames = { plan: 'Plan', i_owe: 'I owe', waiting_on: 'Waiting on' };
const section = 'border-t border-edge py-5';

export function PacksPanel({
  initial,
  change,
  reload,
}: {
  initial: Overview;
  change: (input: PackCommand) => Promise<SituationResult>;
  reload: () => Promise<Overview>;
}) {
  const [overview, setOverview] = useState(initial);
  const [selected, setSelected] = useState(initial.packs[0]?.id ?? '');
  const [preview, setPreview] = useState<SituationPreview>();
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const creationKey = useRef<string | undefined>(undefined);
  const previewElement = useRef<HTMLElement>(null);
  const statusElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (preview) previewElement.current?.scrollIntoView({ block: 'start' });
    else if (notice) statusElement.current?.scrollIntoView({ block: 'center' });
  }, [preview, notice]);
  const pack = overview.packs.find((pack) => pack.id === selected);
  async function run(command: PackCommand) {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await change(command);
      const fresh = await reload();
      setOverview(fresh);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setSelected(result.packId);
      setPreview(result.preview);
      setNotice(
        result.preview
          ? 'Preview only. Nothing in your plan has changed.'
          : command.action === 'apply'
            ? 'Pack updated. Dependent items need review; nothing outside this pack changed.'
            : 'Saved.',
      );
      setEditing(undefined);
      return true;
    } catch {
      setError('Could not reach the server. Reload before retrying if the result is uncertain.');
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="mt-6 space-y-5">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const title = String(new FormData(form).get('title') ?? '');
          creationKey.current ??= crypto.randomUUID();
          if (await run({ action: 'create', title, creationKey: creationKey.current })) {
            form.reset();
            creationKey.current = undefined;
          }
        }}
      >
        <input
          className={`${inputClass} min-w-0 grow`}
          name="title"
          aria-label="New pack title"
          placeholder="A weekend, a job search, a project…"
          maxLength={160}
          required
        />
        <button type="submit" className={btnSm.primary} disabled={busy}>
          Create pack
        </button>
      </form>
      <p
        ref={statusElement}
        role={error ? 'alert' : 'status'}
        className={`text-sm ${error ? 'text-red-700 dark:text-red-300' : 'text-muted'}`}
      >
        {error || notice}
      </p>
      {overview.packs.length > 0 && (
        <label className="flex items-center gap-3 text-sm text-muted">
          Pack
          <select
            aria-label="Choose pack"
            className={`${selectClass} min-w-0 grow`}
            value={selected}
            disabled={busy}
            onChange={(event) => {
              setSelected(event.target.value);
              setPreview(undefined);
              setEditing(undefined);
              setNotice('');
            }}
          >
            {overview.packs.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.title}
                {pack.affectedIds.length ? ' · Needs review' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {!pack && (
        <p className="py-8 text-sm text-muted">
          Start with one situation. Attach saved cards or commitments, then connect the items that
          depend on each other.
        </p>
      )}
      {pack && (
        <article className="rounded-2xl border border-edge bg-raised px-5 sm:px-6">
          <header className="py-5">
            <h2 className="text-lg font-semibold text-strong">{pack.title}</h2>
            <p className="mt-1 text-sm text-muted">
              {pack.affectedIds.length
                ? `${pack.affectedIds.length} linked items need a look`
                : 'No linked changes to review'}{' '}
              · Checked against stored sources
            </p>
          </header>
          {(['plan', 'i_owe', 'waiting_on'] as const).map((lane) => (
            <section key={lane} className={section}>
              <h3 className="mb-3 text-sm font-semibold text-accent">{laneNames[lane]}</h3>
              {pack.data.items.filter((item) => item.lane === lane).length === 0 && (
                <p className="text-sm text-muted">Nothing here yet.</p>
              )}
              <div className="divide-y divide-edge">
                {pack.data.items
                  .filter((item) => item.lane === lane)
                  .map((item) => {
                    const changed = pack.changes.find((change) => change.itemId === item.id);
                    return (
                      <div key={item.id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <h4 className="text-sm font-semibold text-strong">{item.title}</h4>
                          {pack.affectedIds.includes(item.id) && (
                            <span className="shrink-0 text-xs text-amber-800 dark:text-amber-300">
                              Needs review
                            </span>
                          )}
                        </div>
                        {item.details && (
                          <p className="mt-1 whitespace-pre-wrap text-sm text-muted">
                            {item.details}
                          </p>
                        )}
                        {item.snapshot && (
                          <details className="mt-2 text-sm text-muted">
                            <summary className="cursor-pointer">
                              {item.source?.kind === 'card' ? 'Saved card' : 'Commitment'} ·{' '}
                              {item.snapshot.state}
                            </summary>
                            <p className="mt-2 whitespace-pre-wrap">
                              {item.snapshot.title}
                              {'\n'}
                              {item.snapshot.details}
                            </p>
                          </details>
                        )}
                        {item.dependsOn.length > 0 && (
                          <p className="mt-2 text-xs text-muted">
                            Depends on{' '}
                            {item.dependsOn
                              .map((id) => pack.data.items.find((item) => item.id === id)?.title)
                              .join(', ')}
                          </p>
                        )}
                        {changed && (
                          <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
                            Source changed: {changed.before?.state ?? 'none'} →{' '}
                            {changed.after?.state ?? 'unavailable'}. Review before relying on it.
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            className={btnSm.outline}
                            onClick={() => {
                              setEditing(item.id);
                              setPreview(undefined);
                            }}
                          >
                            Review / change
                          </button>
                          {item.needsReview && !changed && (
                            <button
                              type="button"
                              disabled={busy}
                              className={btnSm.outline}
                              onClick={() =>
                                void run({
                                  action: 'reviewed',
                                  packId: pack.id,
                                  version: pack.version,
                                  itemId: item.id,
                                })
                              }
                            >
                              Mark reviewed
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </section>
          ))}
          <section className={section}>
            <button
              type="button"
              disabled={busy}
              className={btnSm.outline}
              onClick={() => {
                setEditing('new');
                setPreview(undefined);
              }}
            >
              Add linked item
            </button>
            {editing && (
              <ItemEditor
                key={`${pack.id}:${editing}`}
                pack={pack}
                item={pack.data.items.find((item) => item.id === editing)}
                sources={overview.sources}
                busy={busy}
                run={run}
                close={() => setEditing(undefined)}
              />
            )}
          </section>
          {preview && (
            <section
              ref={previewElement}
              className={`${section} scroll-mt-24 space-y-3`}
              aria-label="Change preview"
            >
              <h3 className="text-sm font-semibold text-accent">Rehearsal · not applied</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  ['Before', preview.before],
                  ['After', preview.after],
                ].map(([label, raw]) => {
                  const item = raw as Item;
                  return (
                    <div key={String(label)}>
                      <p className="text-xs text-muted">{String(label)}</p>
                      <p className="mt-1 text-sm font-medium">{item.title}</p>
                      <p className="whitespace-pre-wrap text-sm text-muted">{item.details}</p>
                      <p className="mt-2 whitespace-pre-wrap text-xs text-muted">
                        {item.snapshot?.title}
                        {item.snapshot
                          ? ` · ${item.snapshot.state}\n${item.snapshot.details}`
                          : '\nNo linked source'}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="text-sm">
                Review next:{' '}
                {preview.affectedIds
                  .filter((id) => id !== preview.after.id)
                  .map((id) => pack.data.items.find((item) => item.id === id)?.title)
                  .join(', ') || 'No dependent items'}
              </p>
              {preview.unknowns.map((text) => (
                <p key={text} className="text-xs text-muted">
                  {text}
                </p>
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btnSm.primary}
                  disabled={busy}
                  onClick={() =>
                    void run({ action: 'apply', packId: pack.id, previewId: preview.id })
                  }
                >
                  Apply to pack
                </button>
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={busy}
                  onClick={() =>
                    void run({ action: 'dismiss_preview', packId: pack.id, previewId: preview.id })
                  }
                >
                  Discard preview
                </button>
              </div>
            </section>
          )}
          <section className={section}>
            <h3 className="mb-3 text-sm font-semibold text-accent">Choices & reasons</h3>
            {pack.data.decisions.map((decision) => (
              <div className="mb-4" key={decision.id}>
                <p className="text-sm font-medium">
                  {decision.outcome === 'chosen' ? 'Chosen' : 'Passed on'} · {decision.option}
                </p>
                <p className="text-sm text-muted">{decision.reason}</p>
                <p className="mt-1 text-xs text-muted">
                  {decision.scope === 'preference'
                    ? 'Confirmed preference'
                    : 'For this situation only'}
                  {!decision.confirmed ? ' · proposed by assistant' : ''}
                </p>
              </div>
            ))}
            <details>
              <summary className="cursor-pointer text-sm text-accent">Record a decision</summary>
              <form
                className="mt-3 grid gap-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const fields = new FormData(form);
                  if (
                    await run({
                      action: 'decision',
                      packId: pack.id,
                      version: pack.version,
                      decision: {
                        id: crypto.randomUUID(),
                        option: String(fields.get('option')),
                        reason: String(fields.get('reason')),
                        outcome: fields.get('outcome') as 'chosen' | 'rejected',
                        scope: fields.has('preference') ? 'preference' : 'situation',
                        confirmed: true,
                      },
                    })
                  )
                    form.reset();
                }}
              >
                <input
                  name="option"
                  aria-label="Option"
                  className={inputClass}
                  placeholder="Which option?"
                  maxLength={160}
                  required
                />
                <textarea
                  name="reason"
                  aria-label="Reason"
                  className={textareaClass}
                  placeholder="Why did you choose or reject it?"
                  maxLength={2000}
                  required
                />
                <select name="outcome" aria-label="Decision" className={selectClass}>
                  <option value="chosen">Chosen</option>
                  <option value="rejected">Rejected</option>
                </select>
                <label className="flex gap-2 text-sm text-muted">
                  <input type="checkbox" name="preference" />
                  Remember this as a lasting preference, beyond this situation
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className={`${btnSm.outline} justify-self-start`}
                >
                  Save decision
                </button>
              </form>
            </details>
          </section>
          <footer className={`${section} flex flex-wrap items-center justify-between gap-3`}>
            <Link
              className={btnSm.primary}
              href={`/chat?ask=${encodeURIComponent(`Review situation pack ${pack.id}. Read its latest state, respect recorded decisions, identify what I owe and what I am waiting on, and propose the next useful step. Do not perform external actions yet.`)}`}
            >
              Discuss next steps
            </Link>
            <button
              type="button"
              className={btnSm.outline}
              disabled={busy}
              onClick={() =>
                void run({ action: 'archive', packId: pack.id, version: pack.version })
              }
            >
              Archive pack
            </button>
          </footer>
        </article>
      )}
    </div>
  );
}

function ItemEditor({
  pack,
  item,
  sources,
  busy,
  run,
  close,
}: {
  pack: SituationPackView;
  item?: Item;
  sources: Source[];
  busy: boolean;
  run: (command: PackCommand) => Promise<boolean>;
  close: () => void;
}) {
  const newId = useRef<string | undefined>(undefined);
  const baseVersion = useRef(pack.version);
  return (
    <form
      className="mt-4 grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const sourceKey = String(fields.get('source') ?? '');
        const source = sources.find((source) => `${source.kind}:${source.id}` === sourceKey);
        newId.current ??= crypto.randomUUID();
        await run({
          action: item ? 'preview' : 'item',
          packId: pack.id,
          version: baseVersion.current,
          item: {
            id: item?.id ?? newId.current,
            title: String(fields.get('title')),
            details: String(fields.get('details')),
            lane: fields.get('lane') as Item['lane'],
            dependsOn: fields.getAll('dependsOn').map(String),
            source: source
              ? { kind: source.kind, id: source.id }
              : sourceKey && item?.source
                ? item.source
                : null,
          },
        });
      }}
    >
      <h3 className="text-sm font-medium">
        {item ? `Rehearse a change to ${item.title}` : 'New linked item'}
      </h3>
      <label className="grid gap-1 text-xs text-muted">
        Title
        <input
          className={inputClass}
          name="title"
          defaultValue={item?.title}
          maxLength={160}
          required
        />
      </label>
      <label className="grid gap-1 text-xs text-muted">
        Notes
        <textarea
          className={textareaClass}
          name="details"
          defaultValue={item?.details}
          maxLength={2000}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted">
        Lane
        <select className={selectClass} name="lane" defaultValue={item?.lane ?? 'plan'}>
          {Object.entries(laneNames).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-muted">
        Linked source
        <select
          className={selectClass}
          name="source"
          defaultValue={item?.source ? `${item.source.kind}:${item.source.id}` : ''}
        >
          <option value="">No source · planning note</option>
          {item?.source &&
            !sources.some(
              (source) => source.id === item.source?.id && source.kind === item.source.kind,
            ) && (
              <option value={`${item.source.kind}:${item.source.id}`}>
                {item.snapshot?.title ?? 'Current source'} (not active)
              </option>
            )}
          {sources.map((source) => (
            <option key={`${source.kind}:${source.id}`} value={`${source.kind}:${source.id}`}>
              {source.title}
            </option>
          ))}
        </select>
      </label>
      {pack.data.items.some((entry) => entry.id !== item?.id) && (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-xs text-muted">Depends on</legend>
          {pack.data.items
            .filter((entry) => entry.id !== item?.id)
            .map((entry) => (
              <label key={entry.id} className="flex items-center gap-2 text-sm">
                <input
                  name="dependsOn"
                  value={entry.id}
                  type="checkbox"
                  defaultChecked={item?.dependsOn.includes(entry.id)}
                />
                {entry.title}
              </label>
            ))}
        </fieldset>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={btnSm.primary}>
          {item ? 'Preview change' : 'Add item'}
        </button>
        <button type="button" disabled={busy} className={btnSm.outline} onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
