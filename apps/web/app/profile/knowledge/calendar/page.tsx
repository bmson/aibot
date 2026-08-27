import {
  getAssistantLocale,
  getAssistantTimezone,
  getKnowledgeGraphCalendar,
  type KnowledgeGraphCalendarEntry,
} from '@assistant/application';
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react';
import Link from 'next/link';
import {
  buildMonthGrid,
  MONTH_KEY_RE,
  monthKeyInTimeZone,
  monthTitle,
  shiftMonth,
  todayKeyInTimeZone,
  weekdayNames,
  weekStartForLocale,
} from '@/app/profile/knowledge/calendar/calendar-grid';
import { requireOwner } from '@/auth';
import { entityKindLabel, entityKindPaint, humanizePredicate } from '@/lib/knowledge';
import { getDb } from '@/lib/server';
import {
  Badge,
  btn,
  cardTitleClass,
  EmptyState,
  microLabelClass,
  PageHeader,
  PageShell,
} from '@/lib/ui';

export const metadata = { title: 'Knowledge calendar' };
export const dynamic = 'force-dynamic';

/** Connections listed per entry before the rest fold into the date's own page. */
const CELL_CONNECTION_LIMIT = 3;

function calendarHref(month: string): string {
  return `/profile/knowledge/calendar?month=${month}`;
}

function entityHref(entityId: string): string {
  return `/profile/knowledge?entity=${entityId}`;
}

function CalendarEntryRow({ entry }: { entry: KnowledgeGraphCalendarEntry }) {
  const shown = entry.connections.slice(0, CELL_CONNECTION_LIMIT);
  const hidden = entry.connections.length - shown.length;
  return (
    <div className="min-w-0">
      <ul className="grid gap-0.5">
        {shown.map((connection) => (
          <li key={connection.relationId} className="min-w-0">
            <Link
              href={entityHref(connection.other.id)}
              title={`${connection.other.label} — ${entityKindLabel(connection.other.kind)} · ${humanizePredicate(connection.predicate)}`}
              className="flex min-w-0 items-center gap-1 rounded text-xs leading-5 text-strong motion-safe:transition-colors hover:bg-raised"
            >
              <span
                aria-hidden="true"
                className={`inline-block size-1.5 shrink-0 rounded-full ${
                  entityKindPaint(connection.other.kind).swatch
                }`}
              />
              <span className="min-w-0 truncate">{connection.other.label}</span>
            </Link>
            {/* Second hop: the people and places attached to this event or
                project, so a cell reads as a day, not a bare name. */}
            {connection.related.length > 0 ? (
              <span className="flex min-w-0 flex-wrap items-center gap-x-1 pl-2.5 text-[0.68rem] leading-4 text-muted">
                {connection.related.map((item, index) => (
                  <span key={item.id} className="inline-flex min-w-0 items-center">
                    {index > 0 ? (
                      <span aria-hidden="true" className="text-muted/60">
                        {' · '}
                      </span>
                    ) : null}
                    <Link
                      href={entityHref(item.id)}
                      title={`${item.label} — ${entityKindLabel(item.kind)}`}
                      className="max-w-24 truncate rounded underline-offset-2 motion-safe:transition-colors hover:text-strong hover:underline"
                    >
                      {item.label}
                    </Link>
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <Link
          href={entityHref(entry.entity.id)}
          className="mt-0.5 inline-block rounded text-[0.68rem] font-medium text-muted underline-offset-2 motion-safe:transition-colors hover:text-strong hover:underline"
        >
          +{hidden} more
        </Link>
      ) : null}
      {/* A date whose edges are all stale still exists; link it rather than
          render an invisible cell. */}
      {entry.connections.length === 0 ? (
        <Link
          href={entityHref(entry.entity.id)}
          className="inline-block rounded text-[0.68rem] text-muted underline-offset-2 motion-safe:transition-colors hover:text-strong hover:underline"
        >
          {entry.entity.label}
        </Link>
      ) : null}
    </div>
  );
}

export default async function KnowledgeCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const db = getDb();
  const [timeZone, locale] = await Promise.all([getAssistantTimezone(db), getAssistantLocale(db)]);
  const now = new Date();
  const requested = (params.month ?? '').trim();
  const month = MONTH_KEY_RE.test(requested) ? requested : monthKeyInTimeZone(now, timeZone);
  const calendar = await getKnowledgeGraphCalendar(db, { month });
  if (!calendar) return null; // unreachable: month is validated above

  const weekStart = weekStartForLocale(locale);
  const weeks = buildMonthGrid(month, weekStart);
  const todayKey = todayKeyInTimeZone(now, timeZone);
  const title = monthTitle(month, locale);
  const entryCount = Object.values(calendar.days).reduce(
    (total, entries) => total + entries.length,
    0,
  );

  return (
    <PageShell size="wide">
      <PageHeader
        back={{ href: '/profile/knowledge', label: 'Knowledge review' }}
        title={title}
        intro="Dates mentioned in your memories and what they connect to. This is the knowledge graph's date view, not your synced calendar — nothing here implies a scheduled appointment."
        actions={
          <nav className="flex items-center gap-1" aria-label="Month navigation">
            <Link href={calendarHref(shiftMonth(month, -1))} className={btn.outline}>
              <ChevronLeft className="size-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Previous</span>
            </Link>
            <Link href={calendarHref(monthKeyInTimeZone(now, timeZone))} className={btn.outline}>
              Today
            </Link>
            <Link href={calendarHref(shiftMonth(month, 1))} className={btn.outline}>
              <span className="sr-only sm:not-sr-only">Next</span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </Link>
          </nav>
        }
      />

      {entryCount === 0 && !calendar.monthEntry ? (
        <EmptyState>
          <p>
            No dated mentions in {title}. Dates appear here as the knowledge-graph sync reads them
            out of durable memories.
          </p>
        </EmptyState>
      ) : (
        <>
          {calendar.monthEntry && calendar.monthEntry.connections.length > 0 ? (
            <section className="mt-6">
              <h2 className={cardTitleClass}>Mentioned for {title} in general</h2>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {calendar.monthEntry.connections.map((connection) => (
                  <li key={connection.relationId} className="min-w-0">
                    <Link
                      href={entityHref(connection.other.id)}
                      className="inline-flex min-w-0 items-center gap-1.5 rounded text-sm text-strong underline-offset-2 motion-safe:transition-colors hover:underline"
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-block size-2 shrink-0 rounded-full ${
                          entityKindPaint(connection.other.kind).swatch
                        }`}
                      />
                      <span className="min-w-0 truncate">{connection.other.label}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {entityKindLabel(connection.other.kind)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* A real table, not a div grid: row/column semantics give assistive
              tech calendar navigation for free. */}
          <table className="mt-6 w-full table-fixed border-collapse">
            <caption className="sr-only">Dates mentioned in memories during {title}</caption>
            <thead>
              <tr>
                {weekdayNames(locale, weekStart).map((name) => (
                  <th
                    key={name}
                    scope="col"
                    className={`${microLabelClass} border border-edge/60 bg-sunken/50 px-2 py-1.5 text-left text-muted`}
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week, weekIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: weeks are positional
                <tr key={weekIndex}>
                  {week.map((cell, cellIndex) => {
                    const entries = cell.day ? (calendar.days[cell.day] ?? []) : [];
                    const isToday = cell.key === todayKey;
                    return (
                      <td
                        key={cell.key ?? `pad-${weekIndex}-${cellIndex}`}
                        className={`h-24 min-w-0 border border-edge/60 px-1.5 py-1 align-top sm:h-28 ${
                          cell.day ? 'bg-raised' : 'bg-sunken/30'
                        }`}
                      >
                        {cell.day ? (
                          <div className="grid h-full min-w-0 content-start gap-1">
                            <span
                              className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold ${
                                isToday ? 'bg-accent text-on-accent' : 'text-muted'
                              }`}
                            >
                              {isToday ? <span className="sr-only">Today, </span> : null}
                              {Number(cell.day)}
                            </span>
                            {entries.map((entry) => (
                              <div key={entry.entity.id} className="min-w-0">
                                {entry.recurring ? (
                                  <span className="mb-0.5 inline-flex items-center gap-1 text-[0.68rem] font-medium text-muted">
                                    <Repeat className="size-3" aria-hidden="true" />
                                    Yearly
                                  </span>
                                ) : null}
                                <CalendarEntryRow entry={entry} />
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {/* Recurring dates land in the cell of the day they recur on; only
              year-only dates are absent, because no cell can honestly hold them. */}
          <p className="mt-2 text-xs text-muted">
            Dates marked yearly recur every year. Dates known only by their year do not appear in a
            month view.
            {calendar.totalConnections > calendar.shownConnections
              ? ` Showing the first ${calendar.shownConnections.toLocaleString()} of ${calendar.totalConnections.toLocaleString()} connections this month.`
              : ''}
          </p>
        </>
      )}

      <div className="mt-4">
        <Badge tone="neutral" size="xs">
          Knowledge graph dates, not calendar appointments
        </Badge>
      </div>
    </PageShell>
  );
}
