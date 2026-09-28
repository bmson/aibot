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
          Reported spend by billing source. Results are cached for an hour and keep their original
          currency.
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
                  : 'Unavailable'}
                {report.status === 'stale' ? ' · Stale' : ''}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {report.scope} · {report.period} · {report.source}
            </p>
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
              <p className="mt-2 text-xs text-muted">
                Billing export needs to be configured for this installation.
              </p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
