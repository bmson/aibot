import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalRow } from './inline-approval';

describe('standing approval option in chat', () => {
  const label = 'Approve and allow future texts to +14155550199';
  it.each([
    ['pending', label, true],
    ['pending', null, false],
    ['approved', label, false],
  ] as const)(
    'offers a rule only for an eligible pending action (%s)',
    (status, rememberLabel, offered) => {
      const html = renderToStaticMarkup(
        <ApprovalRow
          part={{
            type: 'approval',
            approvalId: 'a1',
            shortCode: 'A123',
            summary: 'Send text',
            status,
            rememberLabel,
          }}
          resolution={undefined}
          busy={false}
          busyDecision={null}
          disabled={false}
          detailsOpenByDefault={false}
          onResolve={() => {}}
        />,
      );
      expect(html.includes(label)).toBe(offered);
    },
  );
});
