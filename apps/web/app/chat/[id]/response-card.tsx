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
  Bell,
  CalendarDays,
  CheckCircle2,
  Clock,
  CloudSun,
  FileText,
  FolderOpen,
  Globe,
  Mail,
  MapPin,
  Users,
  Video,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { focusRing, microLabelClass } from '@/lib/ui';

// Cards fill the transcript column, matching the native chat surface. The
// column itself owns the readable desktop measure; a second, narrower card cap
// made structured results look disconnected from the conversation around them.
const CARD_WIDTH = 'min-w-0 w-full max-w-none';

type Raw = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
  const url = str(parsed.url);
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
      className={`paper ${CARD_WIDTH} overflow-hidden rounded-[1.125rem] border border-edge/70 bg-raised`}
    >
      <div className="flex items-center gap-2.5 border-b border-edge/60 bg-sunken/40 px-4 py-2.5 sm:px-5">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <p className={`${microLabelClass} min-w-0 truncate text-accent`}>{label}</p>
      </div>
      <div className="min-w-0 px-4 py-3.5 sm:px-5">{children}</div>
    </section>
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
  return (
    <CardShell
      icon={Mail}
      label={str(data.query) ? `Email — “${str(data.query)}”` : 'Email results'}
    >
      <ul className="flex flex-col gap-2.5">
        {messages.map((message, index) => (
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
        ))}
      </ul>
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
  return (
    <CardShell icon={Globe} label={str(data.query) ? `Web — “${str(data.query)}”` : 'Web results'}>
      <ul className="flex flex-col gap-2.5">
        {results.map((result, index) => (
          <li key={str(result.url) || index} className="min-w-0 text-sm">
            <a
              href={str(result.url)}
              target="_blank"
              rel="noreferrer"
              className={`font-medium text-accent underline-offset-2 hover:underline ${focusRing}`}
            >
              {str(result.title) || str(result.url)}
            </a>
            {str(result.snippet) ? (
              <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted">
                {str(result.snippet)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
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
  return (
    <CardShell
      icon={FolderOpen}
      label={str(data.query) ? `Drive — “${str(data.query)}”` : 'Drive files'}
    >
      <ul className="flex flex-col gap-2">
        {files.map((file, index) => {
          const href = str(file.url);
          const name = str(file.name) || 'Untitled file';
          return (
            <li key={str(file.id) || index} className="flex min-w-0 items-baseline gap-2 text-sm">
              {href ? (
                <a
                  href={href}
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
        })}
      </ul>
    </CardShell>
  );
}

function DocumentResultsCard({ data }: { data: Raw }) {
  const passages = recs(data.passages);
  return (
    <CardShell
      icon={FileText}
      label={str(data.query) ? `Documents — “${str(data.query)}”` : 'Document matches'}
    >
      <ul className="flex flex-col gap-2.5">
        {passages.map((passage, index) => (
          <li key={str(passage.id) || index} className="min-w-0 text-sm">
            <p className="font-medium text-strong">{str(passage.document)}</p>
            {str(passage.snippet) ? (
              <p className="mt-0.5 line-clamp-3 break-words text-xs leading-5 text-muted">
                {str(passage.snippet)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
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
    ].includes(str(card.kind)),
  );
}

export function ResponseCards({ cards, timeZone }: { cards: Raw[]; timeZone: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {cards.map((card, index) => (
        <ResponseCardView key={str(card.id) || index} data={card} timeZone={timeZone} />
      ))}
    </div>
  );
}
