import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SuggestionContextContent,
  standaloneResponseCards,
  suggestionContext,
  suggestionWakeLabel,
} from './suggestion-context';

const context = {
  kind: 'proactive-alert' as const,
  id: 'email:1',
  title: 'Progress report',
  summary: 'Please review the missing assignments.',
  details: [
    { label: 'From', value: 'teacher@example.com' },
    { label: 'Deadline', value: 'Friday' },
  ],
};

describe('combined suggestion context', () => {
  it('suppresses only a valid paired alert, preserving unrelated and unsupported cards', () => {
    const unrelated = { ...context, id: 'email:2' };
    const weather = { kind: 'weather', id: context.id };
    expect(
      standaloneResponseCards(
        [context, unrelated, weather],
        [{ suggestionId: 's1', contextCard: context }],
      ),
    ).toEqual([unrelated, weather]);
    expect(
      standaloneResponseCards(
        [context],
        [{ suggestionId: 's1', contextCard: { ...context, title: null } }],
      ),
    ).toEqual([context]);
    expect(
      suggestionContext({ ...context, details: [null, { label: 'Bad', value: 5 }] })?.details,
    ).toEqual([]);
  });

  it('keeps the key fact visible while putting sender metadata in disclosure', () => {
    const html = renderToStaticMarkup(
      <SuggestionContextContent context={context} timeZone="America/Los_Angeles" />,
    );
    expect(html).toContain('Progress report');
    expect(html.indexOf('Friday')).toBeLessThan(html.indexOf('<details'));
    expect(html.indexOf('teacher@example.com')).toBeGreaterThan(html.indexOf('<details'));
    expect(html).not.toContain('<details open');
  });

  it('retains full long summaries in details and ignores malformed dates', () => {
    const full = 'Read the report carefully. '.repeat(18);
    const html = renderToStaticMarkup(
      <SuggestionContextContent
        context={{ ...context, summary: full, dueAt: 'invalid' }}
        timeZone="UTC"
      />,
    );
    expect(html).toContain('…');
    expect(html).toContain('invalid');
    expect(html).toContain(full.trim());
    expect(suggestionWakeLabel('invalid', 'UTC')).toBeUndefined();
  });
});
