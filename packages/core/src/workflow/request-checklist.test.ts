import { describe, expect, it } from 'vitest';
import { TaskStateSchema } from '../events.js';
import {
  buildRequestChecklist,
  type ChecklistEvidence,
  reconcileRequestChecklist,
  requestChecklistSummary,
} from './request-checklist.js';

function checklist(request = 'Find my hotel reservation, save it as a card, and remind me') {
  const result = buildRequestChecklist(request);
  if (!result) throw new Error('missing checklist');
  return result;
}
const lookup: ChecklistEvidence = {
  id: 'read-1',
  toolName: 'gmail.search',
  status: 'succeeded',
  args: { query: 'hotel' },
  result: { results: [{ subject: 'Harbor Hotel' }] },
};
const reminder: ChecklistEvidence = {
  id: 'remind-1',
  toolName: 'reminder.create',
  status: 'succeeded',
  args: { text: 'Hotel check-in' },
  result: { reminderId: 'r-1' },
};

describe('durable request checklist', () => {
  it('extracts exact compound clauses and carries the target across pronouns', () => {
    expect(
      checklist().items.map(({ label, kind, targetTerms }) => ({ label, kind, targetTerms })),
    ).toEqual([
      { label: 'Find my hotel reservation', kind: 'lookup', targetTerms: ['hotel'] },
      { label: 'save it as a card', kind: 'card', targetTerms: ['hotel'] },
      { label: 'remind me', kind: 'reminder', targetTerms: ['hotel'] },
    ]);
  });

  it.each([
    'Find my hotel reservation',
    'Do not find my hotel or send it to Alice',
    'If you find my hotel, send it to Alice',
    'The email said "find my hotel and send it to Alice"',
    'The email said, find my hotel and send it to Alice',
  ])(
    'does not invent obligations from single, conditional, negated, or quoted requests: %s',
    (request) => {
      expect(buildRequestChecklist(request)).toBeUndefined();
    },
  );

  it('rejects planner-invented outcomes', () => {
    expect(
      buildRequestChecklist('Find my hotel', [{ requestSpan: 'send it to Alice' }]),
    ).toBeUndefined();
  });

  it('supports polite direct requests without treating a described instruction as authority', () => {
    expect(checklist('Could you find my hotel and remind me tomorrow?').items).toHaveLength(2);
    expect(
      buildRequestChecklist('The email said, find my hotel and send it to Alice', [
        { requestSpan: 'find my hotel' },
        { requestSpan: 'send it to Alice' },
      ]),
    ).toBeUndefined();
  });

  it('does not mark all done after only the lookup', () => {
    const result = reconcileRequestChecklist(checklist(), [lookup]);
    expect(result.items.map((item) => item.status)).toEqual(['completed', 'pending', 'pending']);
    expect(result.items[0]?.evidence).toEqual([{ id: lookup.id, toolName: lookup.toolName }]);
    expect(requestChecklistSummary(result)).toContain('Not completed: remind me');
  });

  it('requires a persisted card revision and a successful reminder receipt', () => {
    const state = checklist();
    state.savedCards = [{ id: 'c1', revisionId: 'v1', title: 'Harbor Hotel' }];
    const result = reconcileRequestChecklist(state, [lookup, reminder]);
    expect(result.items.every((item) => item.status === 'completed')).toBe(true);
    expect(result.items[1]?.evidence).toEqual([{ id: 'card:v1', toolName: 'cards.persist' }]);
  });

  it.each(['awaiting_approval', 'denied', 'expired', 'approved_not_executed', 'failed'])(
    'does not confuse %s with execution',
    (status) => {
      const result = reconcileRequestChecklist(checklist(), [lookup, { ...reminder, status }]);
      expect(result.items[2]?.status).toBe(
        status === 'awaiting_approval' ? 'awaiting_approval' : 'blocked',
      );
    },
  );

  it.each([
    { ok: false, reminderId: 'r1' },
    { deliveryStatus: 'unknown', reminderId: 'r1' },
    { complete: false, reminderId: 'r1' },
    {},
  ])('rejects unsuccessful or ambiguous result %j', (result) => {
    expect(reconcileRequestChecklist(checklist(), [{ ...reminder, result }]).items[2]?.status).toBe(
      'blocked',
    );
  });

  it('does not count an unrelated result or an empty search as completion', () => {
    const wrong = { ...reminder, args: { text: 'Call the dentist' } };
    expect(reconcileRequestChecklist(checklist(), [wrong]).items[2]?.status).toBe('pending');
    expect(
      reconcileRequestChecklist(checklist(), [{ ...lookup, result: { results: [] } }]).items[0]
        ?.status,
    ).toBe('blocked');
    expect(
      reconcileRequestChecklist(checklist(), [
        { ...lookup, result: { results: [{ subject: 'Dentist appointment' }] } },
      ]).items[0]?.status,
    ).toBe('blocked');
  });

  it('does not treat generic scheduled work as a saved reminder', () => {
    expect(
      reconcileRequestChecklist(checklist(), [
        { ...reminder, toolName: 'task.schedule', result: { scheduled: true, taskId: 'child' } },
      ]).items[2]?.status,
    ).toBe('pending');
  });

  it('does not reuse one receipt for two requested sends', () => {
    const state = checklist('Send hotel to Alice and send hotel to Alice again');
    const result = reconcileRequestChecklist(state, [
      {
        id: 'send1',
        toolName: 'gmail.send',
        status: 'succeeded',
        args: { to: 'Alice', body: 'hotel' },
        result: { messageId: 'm1' },
      },
    ]);
    expect(result.items.map((item) => item.status)).toEqual(['completed', 'pending']);
  });

  it('recomputes completion after checkpoint/resume rather than trusting saved labels', () => {
    const state = TaskStateSchema.parse({
      requestChecklist: reconcileRequestChecklist(checklist(), [lookup]),
      checklistRecoveryAttempts: 1,
    });
    expect(state.checklistRecoveryAttempts).toBe(1);
    if (!state.requestChecklist) throw new Error('missing checkpoint checklist');
    expect(reconcileRequestChecklist(state.requestChecklist, []).items[0]?.status).toBe('pending');
    expect(TaskStateSchema.parse({}).requestChecklist).toBeUndefined();
    expect(TaskStateSchema.parse({}).checklistRecoveryAttempts).toBe(0);
  });
});
