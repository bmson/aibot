'use client';

/*
 * Rich response cards — the structured `data-card` parts the executor attaches
 * to a final reply (response-cards.ts in core). The iOS app has rendered these
 * for a while; this is the web surface for the same payloads. When cards are
 * present they ARE the answer, so the chat suppresses the prose bubble that
 * would restate them (mirroring iOS's usesPrimaryCards).
 *
 * Payloads arrive as unknown jsonb and are parsed defensively field by field —
 * an older or newer server build may carry more or less than these types name.
 */
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  Clock,
  CloudSun,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Mail,
  MapPin,
  Users,
  Video,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { focusRing } from '@/lib/ui';

// Cards fill the transcript column, matching the native chat surface. The
// column itself owns the readable desktop measure; a second, narrower card cap
// made structured results look disconnected from the conversation around them.
const CARD_WIDTH = 'min-w-0 w-full max-w-none';
const PREVIEW_LIMIT = 3;

type Raw = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A finite number, or undefined. Never coerce with a bare `Number()`: a card
 * field that is absent serialises as null, and `Number(null)` is 0 — which on
 * a provenance card reads as a measured zero rather than "not known".
 */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A URL safe to put in an href. Card payloads are built from tool results —
 * search hits, mail and Drive links — so they carry the same reach as any
 * other model-adjacent input. Prose links get this for free from
 * react-markdown's URL transform; React itself only warns on a
 * `javascript:` href, so the cards need their own guard. Callers render plain
 * text when this returns empty.
 */
function cardHref(value: unknown): string {
  const raw = str(value);
  if (!raw) return '';
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'http:' || protocol === 'https:' ? raw : '';
  } catch {
    // Not absolute, so not something to link out to either.
    return '';
  }
}

function strs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function rec(value: unknown): Raw | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined;
}

function recs(value: unknown): Raw[] {
  return Array.isArray(value) ? recs0(value) : [];
}

function recs0(value: unknown[]): Raw[] {
  const out: Raw[] = [];
  for (const item of value) {
    const parsed = rec(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function pairs(value: unknown): Array<{ label: string; value: string }> {
  return recs(value).flatMap((entry) => {
    const label = str(entry.label);
    const text = str(entry.value);
    return label && text ? [{ label, value: text }] : [];
  });
}

function link(value: unknown): { label: string; url: string } | undefined {
  const parsed = rec(value);
  if (!parsed) return undefined;
  const url = cardHref(parsed.url);
  if (!url) return undefined;
  return { label: str(parsed.label) || 'Open', url };
}

function timeRange(start: string, end: string, timeZone: string): string {
  const fmt = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(date);
  };
  return [fmt(start), end ? fmt(end) : ''].filter(Boolean).join('–');
}

function shortDate(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

function CardShell({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof CalendarDays;
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`paper relative ${CARD_WIDTH} overflow-hidden rounded-2xl border border-edge/70 bg-raised`}
    >
      <span
        className="absolute top-4 bottom-4 left-0 w-0.5 rounded-full bg-gradient-to-b from-accent via-accent to-sky-300"
        aria-hidden="true"
      />
      <div className="flex items-center gap-2 px-4 pt-4 sm:px-5">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <p className="min-w-0 truncate text-xs font-medium text-accent">{label}</p>
      </div>
      <div className="min-w-0 px-4 pt-3 pb-4 sm:px-5">{children}</div>
    </section>
  );
}

function CardOverflow({ count, children }: { count: number; children: ReactNode }) {
  if (count <= 0) return null;
  return (
    <details className="mt-3 border-t border-edge/60 pt-2.5">
      <summary className="disclosure flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-muted">
        {count} more
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function CardLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex h-7 items-center rounded-full border border-accent/30 px-3 text-xs font-medium text-accent motion-safe:transition-colors hover:bg-accent/10 ${focusRing}`}
    >
      {label}
    </a>
  );
}

function DetailRows({ items }: { items: Array<{ label: string; value: string }> }) {
  if (items.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5 text-xs">
          <dt className="text-muted">{item.label}</dt>
          <dd className="font-medium text-strong">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WeatherCard({ data }: { data: Raw }) {
  const details = pairs(data.details);
  return (
    <CardShell icon={CloudSun} label={str(data.location) || 'Weather'}>
      <p className="text-sm text-strong">
        <span className="text-base font-semibold">{str(data.temperature)}</span>{' '}
        <span className="text-muted">{str(data.condition)}</span>
      </p>
      {details.length > 0 ? (
        <div className="mt-2">
          <DetailRows items={details} />
        </div>
      ) : null}
    </CardShell>
  );
}

function CalendarEventCard({ data }: { data: Raw }) {
  const calendar = link(data.calendarLink);
  const meeting = link(data.meetingLink);
  const attendees = strs(data.attendees).slice(0, 3);
  const calendars = strs(data.calendars);
  return (
    <CardShell icon={CalendarDays} label={str(data.time) || 'Event'}>
      <p className="text-sm font-medium text-strong">{str(data.title) || 'Untitled event'}</p>
      <div className="mt-1.5 flex flex-col gap-1 text-xs text-muted">
        {str(data.location) ? (
          <span className="flex items-center gap-1.5">
            <MapPin className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{str(data.location)}</span>
          </span>
        ) : null}
        {attendees.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <Users className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{attendees.join(', ')}</span>
          </span>
        ) : null}
        {calendars.length > 1 ? (
          <span className="truncate">Across {calendars.join(' + ')}</span>
        ) : null}
      </div>
      {calendar || meeting ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {calendar ? <CardLink href={calendar.url} label={calendar.label} /> : null}
          {meeting ? (
            <span className="inline-flex items-center gap-1">
              <Video className="size-3.5 text-accent" aria-hidden="true" />
              <CardLink href={meeting.url} label={meeting.label} />
            </span>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

function EmailResultsCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const messages = recs(data.messages);
  const renderMessage = (message: Raw, index: number) => (
    <li key={str(message.id) || index} className="min-w-0 text-sm">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 truncate font-medium text-strong">
          {str(message.sender) || 'Unknown sender'}
        </span>
        {str(message.date) ? (
          <span className="shrink-0 text-xs text-muted">
            {shortDate(str(message.date), timeZone)}
          </span>
        ) : null}
      </p>
      <p className="min-w-0 truncate text-sm text-strong">{str(message.subject)}</p>
      {str(message.snippet) ? (
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted">
          {str(message.snippet)}
        </p>
      ) : null}
    </li>
  );
  return (
    <CardShell
      icon={Mail}
      label={str(data.query) ? `Email — “${str(data.query)}”` : 'Email results'}
    >
      <ul className="flex flex-col gap-2.5">
        {messages.slice(0, PREVIEW_LIMIT).map(renderMessage)}
      </ul>
      <CardOverflow count={Math.max(0, messages.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2.5">
          {messages.slice(PREVIEW_LIMIT).map(renderMessage)}
        </ul>
      </CardOverflow>
      {data.complete === false ? (
        <p className="mt-2 text-xs text-muted">
          Showing what the search returned — more may exist.
        </p>
      ) : null}
    </CardShell>
  );
}

function WebSearchCard({ data }: { data: Raw }) {
  const results = recs(data.results);
  const renderResult = (result: Raw, index: number) => (
    <li key={str(result.url) || index} className="min-w-0 text-sm">
      {cardHref(result.url) ? (
        <a
          href={cardHref(result.url)}
          target="_blank"
          rel="noreferrer"
          className={`font-medium text-accent underline-offset-2 hover:underline ${focusRing}`}
        >
          {str(result.title) || str(result.url)}
        </a>
      ) : (
        <span className="font-medium text-strong">{str(result.title) || str(result.url)}</span>
      )}
      {str(result.snippet) ? (
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted">
          {str(result.snippet)}
        </p>
      ) : null}
    </li>
  );
  return (
    <CardShell icon={Globe} label={str(data.query) ? `Web — “${str(data.query)}”` : 'Web results'}>
      <ul className="flex flex-col gap-2.5">{results.slice(0, PREVIEW_LIMIT).map(renderResult)}</ul>
      <CardOverflow count={Math.max(0, results.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2.5">{results.slice(PREVIEW_LIMIT).map(renderResult)}</ul>
      </CardOverflow>
    </CardShell>
  );
}

function AvailabilityCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const busy = recs(data.busy);
  const checked = strs(data.calendarsChecked);
  return (
    <CardShell icon={Clock} label="Free / busy">
      {busy.length === 0 ? (
        <p className="text-sm text-strong">Nothing on the calendar in this window.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {busy.map((slot) => (
            <li
              key={`${str(slot.start)}-${str(slot.end)}-${str(slot.calendar)}`}
              className="flex min-w-0 items-baseline gap-2 text-sm"
            >
              <span className="shrink-0 font-medium text-strong">
                {timeRange(str(slot.start), str(slot.end), timeZone)}
              </span>
              {str(slot.calendar) ? (
                <span className="min-w-0 truncate text-xs text-muted">{str(slot.calendar)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        Busy blocks{checked.length > 0 ? ` across ${checked.join(' + ')}` : ''} — the gaps are free.
        {data.complete === false ? ' Some calendars could not be checked.' : ''}
      </p>
      {str(data.note) ? <p className="mt-1 text-xs text-muted">{str(data.note)}</p> : null}
    </CardShell>
  );
}

function StatusCard({ data }: { data: Raw }) {
  const openLink = link(data.link);
  return (
    <CardShell icon={CheckCircle2} label={str(data.title) || 'Done'}>
      {str(data.detail) ? <p className="text-sm text-strong">{str(data.detail)}</p> : null}
      <div className="mt-1.5">
        <DetailRows items={pairs(data.details)} />
      </div>
      {openLink ? (
        <div className="mt-2.5">
          <CardLink href={openLink.url} label={openLink.label} />
        </div>
      ) : null}
    </CardShell>
  );
}

function ReminderCard({ data }: { data: Raw }) {
  return (
    <CardShell icon={Bell} label="Reminder">
      <p className="text-sm font-medium text-strong">{str(data.title)}</p>
      <div className="mt-1.5">
        <DetailRows
          items={[
            ...(str(data.nextFires) ? [{ label: 'Next', value: str(data.nextFires) }] : []),
            ...(str(data.schedule) ? [{ label: 'Schedule', value: str(data.schedule) }] : []),
          ]}
        />
      </div>
    </CardShell>
  );
}

function DriveResultsCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const files = recs(data.files);
  const renderFile = (file: Raw, index: number) => {
    const url = cardHref(file.url);
    const name = str(file.name) || 'Untitled file';
    return (
      <li key={str(file.id) || index} className="flex min-w-0 items-baseline gap-2 text-sm">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={`min-w-0 truncate font-medium text-accent underline-offset-2 hover:underline ${focusRing}`}
          >
            {name}
          </a>
        ) : (
          <span className="min-w-0 truncate font-medium text-strong">{name}</span>
        )}
        {str(file.modifiedTime) ? (
          <span className="shrink-0 text-xs text-muted">
            {shortDate(str(file.modifiedTime), timeZone)}
          </span>
        ) : null}
      </li>
    );
  };
  return (
    <CardShell
      icon={FolderOpen}
      label={str(data.query) ? `Drive — “${str(data.query)}”` : 'Drive files'}
    >
      <ul className="flex flex-col gap-2">{files.slice(0, PREVIEW_LIMIT).map(renderFile)}</ul>
      <CardOverflow count={Math.max(0, files.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2">{files.slice(PREVIEW_LIMIT).map(renderFile)}</ul>
      </CardOverflow>
    </CardShell>
  );
}

function DocumentResultsCard({ data }: { data: Raw }) {
  const passages = recs(data.passages);
  const renderPassage = (passage: Raw, index: number) => (
    <li key={str(passage.id) || index} className="min-w-0 text-sm">
      <p className="font-medium text-strong">{str(passage.document)}</p>
      {str(passage.snippet) ? (
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted">
          {str(passage.snippet)}
        </p>
      ) : null}
    </li>
  );
  return (
    <CardShell
      icon={FileText}
      label={str(data.query) ? `Documents — “${str(data.query)}”` : 'Document matches'}
    >
      <ul className="flex flex-col gap-2.5">
        {passages.slice(0, PREVIEW_LIMIT).map(renderPassage)}
      </ul>
      <CardOverflow count={Math.max(0, passages.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2.5">
          {passages.slice(PREVIEW_LIMIT).map(renderPassage)}
        </ul>
      </CardOverflow>
    </CardShell>
  );
}

function KnowledgeGraphCard({ data }: { data: Raw }) {
  const edges = recs(data.edges);
  return (
    <CardShell icon={GitBranch} label={str(data.title) || 'Saved connections'}>
      <div className="flex flex-col gap-3">
        {edges.map((edge, index) => (
          <article key={str(edge.id) || index} className="relative pl-4">
            <span className="absolute top-1 bottom-1 left-0 w-px bg-accent/35" aria-hidden="true" />
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              <span className="rounded-full bg-accent/10 px-2.5 py-1 font-medium text-strong">
                {str(edge.fromLabel) ||
                  str(recs(data.nodes).find((node) => str(node.id) === str(edge.from))?.label) ||
                  'Unknown'}
              </span>
              <span className="text-xs text-accent">—{str(edge.label) || 'connected to'}→</span>
              <span className="rounded-full bg-sunken px-2.5 py-1 font-medium text-strong">
                {str(edge.toLabel) ||
                  str(recs(data.nodes).find((node) => str(node.id) === str(edge.to))?.label) ||
                  'Unknown'}
              </span>
            </div>
            {str(edge.evidenceQuote) ? (
              <p className="mt-2 text-xs leading-5 text-strong">“{str(edge.evidenceQuote)}”</p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
              {str(edge.source) ? <span>Source: {str(edge.source)}</span> : null}
              {num(edge.confidence) !== undefined ? (
                <span>Confidence: {Math.round((num(edge.confidence) as number) * 100)}%</span>
              ) : null}
              <span>
                {edge.ownerConfirmed === true ? 'Owner-confirmed' : 'Not owner-confirmed'}
              </span>
            </div>
          </article>
        ))}
      </div>
      {data.complete === false ? (
        <p className="mt-3 text-xs text-muted">More matching connections are available.</p>
      ) : null}
    </CardShell>
  );
}

function CalendarConflictsCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const conflicts = recs(data.conflicts);
  return (
    <CardShell icon={AlertTriangle} label={str(data.title) || 'Schedule conflict'}>
      <div className="flex flex-col gap-4">
        {conflicts.map((conflict, index) => {
          const groups = recs(conflict.groups);
          return (
            <section key={str(conflict.id) || index} aria-label={`Conflict ${index + 1}`}>
              <p className="mb-2 text-xs font-medium text-accent">
                Overlap{' '}
                {timeRange(
                  str(conflict.overlapStart),
                  str(conflict.overlapEnd),
                  str(data.timeZone) || timeZone,
                )}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {groups.map((group) => {
                  const events = recs(group.events);
                  const event = events[0];
                  if (!event) return null;
                  const groupKey = events
                    .map(
                      (source) =>
                        str(source.id) ||
                        `${str(source.calendar)}:${str(source.title)}:${str(source.start)}`,
                    )
                    .join('|');
                  return (
                    <div
                      key={groupKey || `${str(event.title)}:${str(event.start)}`}
                      className="rounded-lg border border-edge/70 bg-sunken/35 p-3"
                    >
                      <p className="text-sm font-medium text-strong">
                        {str(event.title) || 'Untitled event'}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {timeRange(
                          str(event.start),
                          str(event.end),
                          str(data.timeZone) || timeZone,
                        )}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {events.map((source, sourceIndex) => (
                          <span
                            key={str(source.id) || sourceIndex}
                            className="rounded-full border border-edge px-2 py-0.5 text-[10px] text-muted"
                          >
                            {str(source.calendar) || 'Calendar'}
                          </span>
                        ))}
                      </div>
                      {str(event.location) ? (
                        <p className="mt-2 flex items-center gap-1 text-xs text-muted">
                          <MapPin className="size-3" aria-hidden="true" />
                          {str(event.location)}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {data.complete === false ? (
        <p className="mt-3 text-xs text-muted">Some calendars could not be checked.</p>
      ) : null}
    </CardShell>
  );
}

function ResponseCardView({ data, timeZone }: { data: Raw; timeZone: string }) {
  switch (data.kind) {
    case 'weather':
      return <WeatherCard data={data} />;
    case 'calendar-event':
      return <CalendarEventCard data={data} />;
    case 'email-results':
      return <EmailResultsCard data={data} timeZone={timeZone} />;
    case 'web-search-results':
      return <WebSearchCard data={data} />;
    case 'availability':
      return <AvailabilityCard data={data} timeZone={timeZone} />;
    case 'status':
      return <StatusCard data={data} />;
    case 'reminder':
      return <ReminderCard data={data} />;
    case 'drive-results':
      return <DriveResultsCard data={data} timeZone={timeZone} />;
    case 'document-results':
      return <DocumentResultsCard data={data} />;
    case 'knowledge-graph':
      return <KnowledgeGraphCard data={data} />;
    case 'calendar-conflicts':
      return <CalendarConflictsCard data={data} timeZone={timeZone} />;
    default:
      // email-thread, sheet-rows, resource and anything newer keep the prose
      // fallback — an unportable card kind never renders as a broken box.
      return null;
  }
}

/**
 * The cards one assistant message carries, in order. Kinds this surface does
 * not render return null, and the caller keeps the prose bubble for them.
 */
export function responseCardPayloads(parts: unknown[]): Raw[] {
  const out: Raw[] = [];
  for (const part of parts) {
    const parsed = rec(part);
    if (parsed?.type !== 'data-card') continue;
    const data = rec(parsed.data);
    if (data?.kind === 'drive-results' && recs(data.files).length === 0) continue;
    if (data) out.push(data);
  }
  return out;
}

/** True when every card on the message is one this surface can render. */
export function rendersAllCards(cards: Raw[]): boolean {
  return cards.every((card) =>
    [
      'weather',
      'calendar-event',
      'email-results',
      'web-search-results',
      'availability',
      'status',
      'reminder',
      'drive-results',
      'document-results',
      'knowledge-graph',
      'calendar-conflicts',
    ].includes(str(card.kind)),
  );
}

export function ResponseCards({ cards, timeZone }: { cards: Raw[]; timeZone: string }) {
  const preview = cards.slice(0, PREVIEW_LIMIT);
  const overflow = cards.slice(PREVIEW_LIMIT);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {preview.map((card, index) => (
        <ResponseCardView key={str(card.id) || index} data={card} timeZone={timeZone} />
      ))}
      {overflow.length > 0 ? (
        <details className="paper rounded-2xl border border-edge/70 bg-raised px-4 py-3">
          <summary className="disclosure flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-muted">
            {overflow.length} more {overflow.length === 1 ? 'result' : 'results'}
          </summary>
          <div className="mt-3 flex min-w-0 flex-col gap-2">
            {overflow.map((card, index) => (
              <ResponseCardView key={str(card.id) || index} data={card} timeZone={timeZone} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
