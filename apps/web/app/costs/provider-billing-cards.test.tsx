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
    expect(html).toContain('Setup needed');
    expect(html).toContain('Open Google Cloud Billing');
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

it('shows forecast and inclusion without creating a second Vertex total', () => {
  const html = renderToStaticMarkup(
    <ProviderBillingCards
      reports={[
        {
          ...report,
          status: 'reported',
          lines: [
            { service: 'Vertex AI', detail: '', currency: 'USD', cost: 15, credits: 0, net: 15 },
          ],
          forecast: {
            through: '2026-09-16T00:00:00Z',
            observedDays: 15,
            daysInMonth: 30,
            totals: [{ currency: 'USD', spent: 15, dailyAverage: 1, projected: 30 }],
            message: 'Assumes similar usage.',
          },
        },
        {
          ...report,
          id: 'vertex',
          label: 'Google Vertex AI',
          status: 'included',
          includedIn: 'google-cloud',
        },
      ]}
    />,
  );
  expect(html).toContain('Estimated month end');
  expect(html).toContain('$30.00');
  expect(html).toContain('Average per day');
  expect(html).toContain('Included in Google Cloud');
  expect(html).not.toContain('Unavailable');
});
