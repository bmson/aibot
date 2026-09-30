import { AUDIT_SECTIONS, type AuditSection } from '@assistant/application/audit-investigation';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getAuditInvestigation } from '@/lib/audit-investigation';
import { btn, PageHeader, PageShell } from '@/lib/ui';
import { InvestigationBrief } from './investigation-brief';

export const metadata = { title: 'Audit investigation' };
export const dynamic = 'force-dynamic';
const labels: Record<AuditSection, string> = {
  toolCalls: 'Tool actions',
  modelCalls: 'Model calls',
  modelCallAudit: 'Model context and answers',
  approvals: 'Approvals',
  messages: 'Task messages',
  contextMessages: 'Conversation at task start',
  responseChecks: 'Response quality checks',
  recallMetrics: 'Recall diagnostics',
};
const payloadFields = new Set([
  'args',
  'result',
  'error',
  'decision',
  'payload',
  'resolutionPayload',
  'systemPrompt',
  'input',
  'output',
  'text',
]);
function fieldLabel(key: string) {
  const names: Record<string, string> = {
    args: 'Arguments',
    result: 'Result',
    error: 'Error',
    decision: 'Policy decision',
    payload: 'Approval request',
    resolutionPayload: 'Approval response',
    systemPrompt: 'System instructions',
    input: 'Model input',
    output: 'Model output',
    text: 'Message',
  };
  return (
    names[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())
  );
}
export default async function AuditDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    section?: string;
    cursor?: string;
    entry?: string;
    field?: string;
    offset?: string;
  }>;
}) {
  await requireOwner();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const query = await searchParams;
  if (query.section && !AUDIT_SECTIONS.includes(query.section as AuditSection)) notFound();
  const section = query.section as AuditSection | undefined;
  let report: Awaited<ReturnType<typeof getAuditInvestigation>>;
  try {
    report = await getAuditInvestigation(id, {
      section,
      cursor: query.cursor,
      entryId: query.entry,
      field: query.field,
      offset: query.offset ? Number(query.offset) : undefined,
      limit: 10,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) notFound();
    throw error;
  }
  if (!report) notFound();
  const task = report.task as Record<string, unknown>;
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader
        back={{ href: '/audit', label: 'Audit trail' }}
        title={String(task.title || task.type)}
        intro="Follow the request, decisions, evidence, and response to understand what happened."
      />
      <div className="grid gap-2">
        <p className="font-semibold">
          {String(task.status)} · Attempt {String(task.attempt)} · {String(task.spentUsd)} USD spent
        </p>
        <code className="break-all text-xs">{id}</code>
        <p className="whitespace-pre-wrap text-sm">{String(task.progress || '')}</p>
      </div>
      <InvestigationBrief prompt={report.investigationPrompt} />
      <details className="rounded-xl border border-edge p-4">
        <summary className="cursor-pointer font-semibold">Task setup and diagnostics</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(report.task, null, 2)}
        </pre>
      </details>
      <details className="rounded-xl bg-sunken p-4 text-sm">
        <summary className="cursor-pointer font-semibold">
          Evidence coverage and limitations
        </summary>
        <ul className="mt-2 grid list-disc gap-2 pl-5">
          {report.evidenceNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
      <nav aria-label="Audit sections" className="flex flex-wrap gap-2">
        <Link className={btn.outline} href={`/audit/${id}`}>
          Overview
        </Link>
        {AUDIT_SECTIONS.map((name) => (
          <Link
            key={name}
            className={btn.outline}
            href={`/audit/${id}?section=${name}`}
            aria-current={section === name ? 'page' : undefined}
          >
            {labels[name]}
          </Link>
        ))}
      </nav>
      {report.sections.map((group) => (
        <section key={group.name} className="grid gap-3" aria-label={labels[group.name]}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{labels[group.name]}</h2>
            <a
              className={btn.outline}
              href={`/api/audit/${id}?${new URLSearchParams({ section: group.name, ...(query.cursor && section === group.name ? { cursor: query.cursor } : {}), ...(query.entry && section === group.name ? { entry: query.entry } : {}), ...(query.field && section === group.name ? { field: query.field, offset: query.offset ?? '0' } : {}) }).toString()}`}
              download
            >
              Download records
            </a>
          </div>
          {group.entries.length === 0 ? (
            <p className="text-sm text-muted">
              No records available in this view. Older tasks may have missing or expired capture.
            </p>
          ) : null}
          {group.entries.map((entry) => (
            <article key={entry.id} className="rounded-xl border border-edge p-4">
              <p className="text-sm font-semibold">
                {entry.fields.toolName?.text ||
                  entry.fields.model?.text ||
                  entry.fields.role?.text ||
                  entry.fields.status?.text ||
                  labels[group.name]}
              </p>
              <p className="mt-1 break-all text-xs text-muted">
                {entry.at} · {entry.id}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                {Object.entries(entry.fields)
                  .filter(
                    ([key, field]) =>
                      !payloadFields.has(key) &&
                      !['id', 'createdAt', 'requestedAt'].includes(key) &&
                      field.text &&
                      field.text !== 'null',
                  )
                  .map(([key, field]) => (
                    <div key={key} className="min-w-0">
                      <dt className="text-muted">{fieldLabel(key)}</dt>
                      <dd className="break-words">{field.text}</dd>
                    </div>
                  ))}
              </dl>
              {Object.entries(entry.fields)
                .filter(
                  ([key, field]) => payloadFields.has(key) && field.text && field.text !== 'null',
                )
                .map(([key, field]) => (
                  <details
                    key={key}
                    className="mt-3"
                    open={query.field === key || ['error', 'text', 'output'].includes(key)}
                  >
                    <summary className="cursor-pointer text-sm">
                      {fieldLabel(key)}
                      {field.hasMore ? ' · more available' : ''}
                    </summary>
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunken p-3 text-xs">
                      {field.text || 'Not recorded'}
                    </pre>
                    {field.hasMore ? (
                      <Link
                        className="text-sm underline"
                        href={`/audit/${id}?section=${group.name}&entry=${entry.id}&field=${encodeURIComponent(key)}&offset=${field.offset + field.text.length}`}
                      >
                        Continue this field ({field.offset + field.text.length} of{' '}
                        {field.totalChars} characters)
                      </Link>
                    ) : null}
                  </details>
                ))}
            </article>
          ))}
          {group.nextCursor ? (
            <Link
              className={btn.outline}
              href={`/audit/${id}?section=${group.name}&cursor=${encodeURIComponent(group.nextCursor)}`}
            >
              Older {labels[group.name].toLowerCase()}
            </Link>
          ) : null}
        </section>
      ))}
    </PageShell>
  );
}
