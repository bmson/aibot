import type { ProviderBilling } from '@assistant/application/provider-billing';
import { cardShellClass } from '@/lib/ui';

function money(value: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 8 : 2,
  }).format(value);
}

export function ProviderBillingCards({ reports }: { reports: ProviderBilling[] }) {
  return (
    <section className="mt-8 space-y-4" aria-label="Provider billing">
      <div>
        <h2 className="text-lg font-semibold">Provider billing</h2>
        <p className="mt-1 text-sm text-muted">
          Month-to-date charges and estimated month-end spend. Vertex AI is part of Google Cloud.
          Sources keep their original currency and refresh hourly.
        </p>
      </div>
      {reports.map((report) => {
        const totals = new Map<string, number>();
        const services = new Map<
          string,
          { service: string; currency: string; net: number; credits: number }
        >();
        for (const line of report.lines) {
          totals.set(line.currency, (totals.get(line.currency) ?? 0) + line.net);
          const key = `${line.service}:${line.currency}`;
          const aggregate = services.get(key) ?? {
            service: line.service,
            currency: line.currency,
            net: 0,
            credits: 0,
          };
          aggregate.net += line.net;
          aggregate.credits += line.credits;
          services.set(key, aggregate);
        }
        return (
          <article key={report.id} className={`${cardShellClass} p-4`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">{report.label}</h3>
              <span className="text-sm tabular-nums">
                {totals.size
                  ? [...totals].map(([currency, total]) => money(total, currency)).join(' · ')
                  : report.includedIn
                    ? 'Included in Google Cloud'
                    : report.status === 'not_configured'
                      ? 'Setup needed'
                      : 'Unavailable'}
                {report.status === 'stale' ? ' · Stale' : ''}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {report.scope} · {report.period} · {report.source}
            </p>
            {report.forecast ? (
              <div className="mt-4 rounded-xl bg-sunken/55 p-3">
                {report.forecast.totals.map((total) => (
                  <div key={total.currency} className="flex flex-wrap justify-between gap-3">
                    <p className="text-sm">
                      Estimated month end{' '}
                      <strong className="block text-xl tabular-nums">
                        {money(total.projected, total.currency)}
                      </strong>
                    </p>
                    <p className="text-sm text-muted">
                      Average per day{' '}
                      <span className="block tabular-nums">
                        {money(total.dailyAverage, total.currency)}
                      </span>
                    </p>
                  </div>
                ))}
                <p className="mt-2 text-xs text-muted">{report.forecast.message}</p>
              </div>
            ) : report.status === 'reported' ? (
              <p className="mt-2 text-xs text-muted">
                Month-end estimate needs at least three days of reported usage.
              </p>
            ) : null}
            <p className="mt-3 text-sm text-muted">{report.message}</p>
            {report.fetchedAt ? (
              <p className="mt-2 text-xs text-muted">
                Fetched {report.fetchedAt.replace('T', ' ').replace('.000Z', ' UTC')}
              </p>
            ) : null}
            {report.latestExportAt ? (
              <p className="mt-1 text-xs text-muted">
                Latest export {report.latestExportAt} · Latest usage {report.latestUsageAt}
              </p>
            ) : null}
            {services.size > 0 ? (
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-2">Service</th>
                    <th className="text-right">Credits</th>
                    <th className="text-right">Net spend</th>
                  </tr>
                </thead>
                <tbody>
                  {[...services.entries()].map(([key, service]) => (
                    <tr key={key} className="border-t border-edge/60">
                      <td className="py-2">{service.service}</td>
                      <td className="text-right tabular-nums">
                        {money(service.credits, service.currency)}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(service.net, service.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {report.id === 'google-cloud' && report.status === 'not_configured' ? (
              <div className="mt-3 text-sm">
                <p>
                  Enable standard usage export in Google Cloud Billing, then connect its BigQuery
                  table and grant this installation read access. Initial data can take hours or
                  days.
                </p>
                <a
                  className="mt-2 inline-block underline"
                  href="https://console.cloud.google.com/billing"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Cloud Billing
                </a>
                {' · '}
                <a
                  className="underline"
                  href="https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup"
                  target="_blank"
                  rel="noreferrer"
                >
                  Export setup guide
                </a>
                <p className="mt-2 text-xs text-muted">
                  Google Cloud and Vertex AI are missing from this overview until the export is
                  connected. Missing costs are not zero.
                </p>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
