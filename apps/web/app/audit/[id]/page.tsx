import type { RecordedValue } from '@assistant/application/tasks';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd } from '@/lib/format';
import { getTaskActivityDetail } from '@/lib/task-activity';
import { btn, PageHeader, PageShell } from '@/lib/ui';
import { StatusChip } from '@/lib/views';

export const metadata = { title: 'Audit record' };
export const dynamic = 'force-dynamic';
function Recorded({ label, value }: { label: string; value: RecordedValue | null }) {
  if (!value) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm">{label}</summary>
      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunken p-3 text-xs">
        {value.text}
      </pre>
      {value.truncated ? (
        <p className="text-xs text-muted">
          This value is truncated ({value.text.length} of {value.totalChars} characters).
        </p>
      ) : null}
    </details>
  );
}
export default async function AuditDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const { before } = await searchParams;
  const cursor = before ? new Date(before) : undefined;
  const detail = await getTaskActivityDetail(
    id,
    cursor && Number.isFinite(cursor.getTime()) ? { before: cursor } : {},
  );
  if (!detail) notFound();
  const events = [
    ...detail.toolCalls.map((call) => ({
      id: `tool-${call.id}`,
      at: call.createdAt,
      title: `Tool: ${call.toolName}`,
      content: (
        <>
          <StatusChip status={call.status} />
          <Recorded label="Arguments" value={call.args} />
          <Recorded label="Result" value={call.result} />
          <Recorded label="Error" value={call.error} />
        </>
      ),
    })),
    ...detail.modelCalls.map((call) => ({
      id: `model-${call.id}`,
      at: call.createdAt,
      title: `Model: ${call.model}`,
      content: (
        <p className="text-sm text-muted">
          {call.role} · {formatUsd(call.costUsd)} · {call.latencyMs ?? '—'} ms
        </p>
      ),
    })),
    ...detail.approvals.map((item) => ({
      id: `approval-${item.id}`,
      at: item.requestedAt,
      title: 'Approval',
      content: (
        <>
          <StatusChip status={item.status} />
          <p className="mt-2 text-sm">{item.summary}</p>
          <p className="text-xs text-muted">{item.resolvedVia ?? 'Awaiting decision'}</p>
        </>
      ),
    })),
    ...detail.messages.map((item) => ({
      id: `message-${item.id}`,
      at: item.createdAt,
      title: `Message: ${item.role}`,
      content: <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const oldest = events.at(-1)?.at;
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader
        back={{ href: '/audit', label: 'Audit trail' }}
        title={detail.task.title || detail.task.type}
        intro="Recorded task activity. All times use the assistant’s timezone."
      />
      <div className="grid gap-2">
        <StatusChip status={detail.task.status} />
        <code className="text-xs break-all">{id}</code>
        <p className="text-sm">{detail.task.progress}</p>
      </div>
      <div className="divide-y divide-edge border-y border-edge">
        {events.map((event) => (
          <article key={event.id} className="py-5">
            <h2 className="font-semibold">{event.title}</h2>
            <p className="mb-3 text-xs text-muted">{formatDateTime(event.at, detail.timezone)}</p>
            {event.content}
          </article>
        ))}
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-muted">No timeline entries recorded.</p>
      ) : null}
      {detail.hasMoreTimeline && oldest ? (
        <Link
          className={btn.outline}
          href={`/audit/${id}?before=${encodeURIComponent(oldest.toISOString())}`}
        >
          Older entries
        </Link>
      ) : null}
    </PageShell>
  );
}
