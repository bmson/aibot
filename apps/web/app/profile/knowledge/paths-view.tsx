import type { KnowledgeGraphPath, KnowledgeGraphPathStep } from '@assistant/application';
import Link from 'next/link';
import { entityKindLabel, formatCanonicalDateKey, humanizePredicate } from '@/lib/knowledge';
import { focusRing } from '@/lib/ui';

/**
 * The Paths view: a managed flowchart. Instead of drawing the whole
 * neighbourhood at once (which becomes a hairball on a hub), it renders a
 * handful of curated, cycle-free chains as vertical flows. Server-rendered —
 * no layout math, no client JS, and every chain is a nested list of links for
 * assistive technology by construction.
 */

function StepConnector({ step, locale }: { step: KnowledgeGraphPathStep; locale: string }) {
  return (
    <li className="flex items-start gap-2 py-1 pl-3 text-xs text-muted">
      <span aria-hidden="true" className="text-accent">
        ↓
      </span>
      <span className="min-w-0">
        {humanizePredicate(step.predicate)}
        {step.validFrom || step.validUntil
          ? ` · ${step.validFrom ? formatCanonicalDateKey(step.validFrom, locale) : '?'} to ${
              step.validUntil ? formatCanonicalDateKey(step.validUntil, locale) : 'now'
            }`
          : ''}
        {step.reviewStatus !== 'confirmed' ? (
          <span className="text-amber-700 dark:text-amber-300"> · needs review</span>
        ) : null}
      </span>
    </li>
  );
}

function StepEntity({
  step,
  hrefFor,
}: {
  step: KnowledgeGraphPathStep;
  hrefFor: (entityId: string) => string;
}) {
  return (
    <li className="min-w-0">
      <Link
        href={hrefFor(step.entity.id)}
        title={`${step.entity.label} — ${entityKindLabel(step.entity.kind)}`}
        className={`block min-w-0 rounded-lg bg-raised px-3 py-2 ring-1 ring-edge/70 motion-safe:transition-colors hover:bg-sunken/40 ${focusRing}`}
      >
        <span className="block truncate text-sm font-medium text-strong">{step.entity.label}</span>
        <span className="block text-xs text-muted">{entityKindLabel(step.entity.kind)}</span>
      </Link>
    </li>
  );
}

export function KnowledgeGraphPaths({
  paths,
  centerLabel,
  centerKind,
  hrefFor,
  locale,
}: {
  paths: KnowledgeGraphPath[];
  centerLabel: string;
  centerKind: string;
  hrefFor: (entityId: string) => string;
  locale: string;
}) {
  if (paths.length === 0) {
    return (
      <p className="rounded-xl bg-sunken/40 px-5 py-8 text-center text-sm text-muted">
        No active connections to chart yet.
      </p>
    );
  }
  return (
    <ol className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {paths.map((path) => (
        <li key={path.steps.map((step) => step.relationId).join('-')} className="min-w-0">
          <ol className="rounded-xl bg-sunken/40 p-3">
            <li className="min-w-0">
              <div className="rounded-lg bg-raised px-3 py-2 ring-1 ring-accent/30">
                <span className="block truncate text-sm font-semibold text-strong">
                  {centerLabel}
                </span>
                <span className="block text-xs text-muted">{entityKindLabel(centerKind)}</span>
              </div>
            </li>
            {path.steps.flatMap((step) => [
              <StepConnector key={`${step.relationId}-c`} step={step} locale={locale} />,
              <StepEntity key={step.relationId} step={step} hrefFor={hrefFor} />,
            ])}
          </ol>
        </li>
      ))}
    </ol>
  );
}
