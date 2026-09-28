import type { ProviderBilling } from '@assistant/application/provider-billing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderBillingCards } from './provider-billing-cards';

const report: ProviderBilling = {
  id: 'google-cloud',
  label: 'Google Cloud',
  status: 'not_configured',
  period: '2026-09',
  scope: 'Project: assistant',
  source: 'Cloud Billing export',
  message: 'Export is not connected.',
  fetchedAt: null,
  latestExportAt: null,
  latestUsageAt: null,
  lines: [],
};

describe('provider billing presentation', () => {
  it('shows missing spend as unavailable rather than zero', () => {
    const html = renderToStaticMarkup(<ProviderBillingCards reports={[report]} />);
    expect(html).toContain('Unavailable');
    expect(html).toContain('Project: assistant');
    expect(html).not.toContain('$0.00');
  });
  it('keeps currencies separate, displays credits and identifies stale data', () => {
    const html = renderToStaticMarkup(
      <ProviderBillingCards
        reports={[
          {
            ...report,
            status: 'stale',
            fetchedAt: '2026-09-26T00:00:00.000Z',
            lines: [
              {
                service: 'Cloud Firestore',
                detail: '',
                currency: 'USD',
                cost: 10,
                credits: -2,
                net: 8,
              },
              { service: 'Cloud Run', detail: '', currency: 'EUR', cost: 3, credits: 0, net: 3 },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('$8.00');
    expect(html).toContain('€3.00');
    expect(html).toContain('-$2.00');
    expect(html).toContain('Stale');
    expect(html).toContain('Fetched 2026-09-26');
    expect(html).not.toContain('$11.00');
  });
});
