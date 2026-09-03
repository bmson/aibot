import { describe, expect, it } from 'vitest';
import { responseCardSteps } from './card-steps.js';
import type { ActionEvidence } from './response-contract.js';

function row(value: Partial<ActionEvidence> & { toolName: string }): ActionEvidence {
  return { status: 'succeeded', result: null, ...value };
}

describe('responseCardSteps', () => {
  it('reads the trail off the ledger in execution order', () => {
    const steps = responseCardSteps([
      row({
        toolName: 'gmail.read_thread',
        step: 2,
        args: { threadId: 't1' },
        result: { messages: [{ subject: 'Fwd: Hotels.com travel confirmation' }] },
      }),
      row({
        toolName: 'gmail.search',
        step: 1,
        args: { query: 'from:Katie hotels.com 73535835545212' },
        result: { results: [{ subject: 'Fwd: Hotels.com travel confirmation' }] },
      }),
    ]);
    expect(steps).toEqual([
      {
        tool: 'gmail.search',
        count: '1 result',
        detail: 'from:Katie hotels.com 73535835545212',
      },
      {
        tool: 'gmail.read_thread',
        count: '1 message',
        detail: 'Fwd: Hotels.com travel confirmation',
      },
    ]);
  });

  it('counts every collection in its own units and pluralizes it', () => {
    const steps = responseCardSteps([
      row({ toolName: 'calendar.list_events', step: 1, result: { events: [{}, {}] } }),
      row({ toolName: 'memory.recall', step: 2, result: { memories: [{}] } }),
      row({ toolName: 'drive.search', step: 3, result: { files: [] } }),
    ]);
    expect(steps.map((step) => step.count)).toEqual(['2 events', '1 memory', '0 files']);
  });

  it('keeps a failed call in the trail with its reason', () => {
    const steps = responseCardSteps([
      row({ toolName: 'gmail.search', step: 1, result: { results: [{}] } }),
      row({
        toolName: 'web.fetch',
        step: 2,
        status: 'failed',
        args: { url: 'https://hotels.example/booking' },
        error: 'Upstream returned 503',
      }),
      row({ toolName: 'calendar.create_event', step: 3, status: 'denied', args: { summary: 'x' } }),
    ]);
    expect(steps[1]).toEqual({
      tool: 'web.fetch',
      failed: true,
      error: 'Upstream returned 503',
      detail: 'https://hotels.example/booking',
    });
    expect(steps[2]).toMatchObject({
      tool: 'calendar.create_event',
      failed: true,
      error: 'Not approved',
    });
  });

  it('describes only completed work from this task', () => {
    const steps = responseCardSteps([
      // An earlier turn's row: context the contract may read, not work this
      // answer did.
      row({ toolName: 'gmail.search', step: 1, fromCurrentTask: false, result: { results: [{}] } }),
      row({ toolName: 'gmail.search', step: 1, result: { results: [{}] } }),
      // Caught mid-stride — it produced nothing to show.
      row({ toolName: 'drive.search', step: 2, status: 'executing' }),
    ]);
    expect(steps.map((step) => step.tool)).toEqual(['gmail.search']);
  });

  it('clips a long detail rather than carrying a whole message body', () => {
    const [step] = responseCardSteps([
      row({ toolName: 'memory.save', step: 1, args: { text: 'x'.repeat(400) } }),
    ]);
    expect(step?.detail).toHaveLength(160);
    expect(step?.detail?.endsWith('…')).toBe(true);
  });

  it('says nothing about a turn that called no tools', () => {
    expect(responseCardSteps([])).toEqual([]);
  });
});
