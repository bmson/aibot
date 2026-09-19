import { focusRing } from '@/lib/ui';

export interface SuggestionContext {
  kind: 'proactive-alert';
  id: string;
  title: string;
  category?: string;
  urgencyLabel?: string;
  summary?: string;
  startsAt?: string;
  dueAt?: string;
  details?: Array<{ label: string; value: string }>;
}

export function suggestionContext(value: unknown): SuggestionContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const card = value as Record<string, unknown>;
  if (
    card.kind !== 'proactive-alert' ||
    typeof card.id !== 'string' ||
    !card.id ||
    typeof card.title !== 'string' ||
    !card.title.trim()
  )
    return undefined;
  const text = (key: string) => (typeof card[key] === 'string' ? (card[key] as string) : undefined);
  return {
    kind: 'proactive-alert',
    id: card.id,
    title: card.title,
    category: text('category'),
    urgencyLabel: text('urgencyLabel'),
    summary: text('summary'),
    startsAt: text('startsAt'),
    dueAt: text('dueAt'),
    details: Array.isArray(card.details)
      ? card.details.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const entry = item as Record<string, unknown>;
          return typeof entry.label === 'string' && typeof entry.value === 'string'
            ? [{ label: entry.label, value: entry.value }]
            : [];
        })
      : [],
  };
}

export function standaloneResponseCards(
  cards: Record<string, unknown>[],
  suggestions: Array<{ suggestionId?: unknown; contextCard?: unknown }>,
): Record<string, unknown>[] {
  const embedded = new Set(
    suggestions.flatMap((part) => {
      if (typeof part.suggestionId !== 'string' || !part.suggestionId.trim()) return [];
      const context = suggestionContext(part.contextCard);
      return context ? [context.id] : [];
    }),
  );
  return cards.filter((card) => card.kind !== 'proactive-alert' || !embedded.has(String(card.id)));
}

function shortSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 180) return clean;
  const head = clean.slice(0, 180);
  return `${head.slice(0, Math.max(head.lastIndexOf(' '), 140)).trimEnd()}…`;
}

export function suggestionWakeLabel(
  value: string | undefined,
  timeZone: string,
): string | undefined {
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date)
    : undefined;
}

export function SuggestionContextContent({
  context,
  timeZone,
  showTitle = true,
}: {
  context: SuggestionContext;
  timeZone: string;
  showTitle?: boolean;
}) {
  const summary = context.summary?.trim() ?? '';
  const preview = shortSummary(summary);
  const details = context.details ?? [];
  const temporalFacts = [
    { label: 'Starts', raw: context.startsAt },
    { label: 'Due', raw: context.dueAt },
  ].flatMap(({ label, raw }) => {
    if (!raw) return [];
    const formatted = suggestionWakeLabel(raw, timeZone);
    return [{ label, value: formatted ?? raw, valid: Boolean(formatted) }];
  });
  const allFacts = [...temporalFacts, ...details.map((item) => ({ ...item, valid: true }))];
  const facts = allFacts
    .filter(
      (item) =>
        item.valid &&
        !['from', 'source'].includes(item.label.toLowerCase()) &&
        item.value.length <= 100,
    )
    .slice(0, 3);
  const additional = allFacts.filter((item) => !facts.includes(item));
  return (
    <div className="min-w-0 break-words [overflow-wrap:anywhere]">
      {showTitle ? (
        <p className="text-base font-semibold leading-6 text-strong">{context.title}</p>
      ) : null}
      {preview ? <p className="mt-1.5 text-sm leading-6 text-muted">{preview}</p> : null}
      {facts.length ? (
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={`${fact.label}-${fact.value}`} className="min-w-0">
              <dt className="text-xs text-muted">{fact.label}</dt>
              <dd className="mt-0.5 text-strong">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {additional.length || preview !== summary ? (
        <details className="mt-3 text-sm">
          <summary
            className={`w-fit cursor-pointer rounded text-xs font-medium text-muted ${focusRing}`}
          >
            Details
          </summary>
          {preview !== summary ? (
            <p className="mt-2 whitespace-pre-wrap leading-6 text-muted">{summary}</p>
          ) : null}
          <dl className="mt-2 space-y-2">
            {additional.map((fact) => (
              <div key={`${fact.label}-${fact.value}`}>
                <dt className="text-xs text-muted">{fact.label}</dt>
                <dd className="mt-0.5 text-strong">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
