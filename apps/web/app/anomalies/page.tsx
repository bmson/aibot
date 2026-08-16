import { AnomalyCard, type AnomalyView } from '@/app/anomalies/anomaly-card';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getApplication } from '@/lib/server';
import { cardGridClass, EmptyState, PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Anomalies' };

export const dynamic = 'force-dynamic';

export default async function AnomaliesPage() {
  await requireOwner();
  const now = new Date();
  const rows = await getApplication().listAnomalies();

  const anomalies: AnomalyView[] = rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    toolName: a.toolName,
    detail: a.detail,
    observed: a.observed,
    expected: a.expected,
    citationCount: a.toolCallIds.length,
    hasPolicy: a.policyId !== null,
    createdLabel: relativeTime(a.createdAt, now),
  }));

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Anomalies"
        intro="Unusual approval-policy activity the nightly scan flagged — a policy auto-executing far above its baseline, an outward action overnight, or a burst. Suspend a policy to make its actions wait for your approval, or dismiss a false positive."
      />

      <section className="mt-8">
        {anomalies.length === 0 ? (
          <EmptyState>Nothing unusual. The scan runs nightly and flags anything here.</EmptyState>
        ) : (
          <div className={cardGridClass}>
            {anomalies.map((anomaly) => (
              <AnomalyCard key={anomaly.id} anomaly={anomaly} />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
