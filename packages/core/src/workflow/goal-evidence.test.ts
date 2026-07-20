import { describe, expect, it } from 'vitest';
import {
  isGoalWorkEvidence,
  isGoalWorkEvidenceTool,
  needsGoalProgressToolRetry,
  needsGoalProgressUpdate,
} from './goal-evidence.js';

describe('isGoalWorkEvidenceTool', () => {
  it.each(['web.fetch', 'browser.execute', 'gmail.search', 'docs.create'])(
    'accepts verified work from %s',
    (toolName) => expect(isGoalWorkEvidenceTool(toolName)).toBe(true),
  );

  it.each(['goals.update_progress', 'goals.list', 'workspace.list', 'browser.plan'])(
    'does not let %s prove its own progress',
    (toolName) => expect(isGoalWorkEvidenceTool(toolName)).toBe(false),
  );

  it.each([
    ['web.fetch', { status: 429, text: '' }],
    ['browser.execute', { ok: false, error: 'timed out' }],
    ['gmail.send', { deliveryStatus: 'unknown' }],
  ])('rejects semantic failure evidence from %s', (toolName, result) => {
    expect(isGoalWorkEvidence({ toolName, status: 'succeeded', result })).toBe(false);
  });

  it('accepts a semantically successful work result', () => {
    expect(
      isGoalWorkEvidence({
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'doc-1' },
      }),
    ).toBe(true);
  });

  it('detects a provider that ignored the forced goal progress tool', () => {
    expect(needsGoalProgressToolRetry([])).toBe(true);
    expect(needsGoalProgressToolRetry([{ toolName: 'goals.update_progress' }])).toBe(false);
  });

  it('requires progress after the latest verified work step', () => {
    const work = (step: number) => ({
      toolName: 'docs.create',
      status: 'succeeded',
      result: { documentId: `doc-${step}` },
      step,
    });
    const progress = (step: number) => ({
      toolName: 'goals.update_progress',
      status: 'succeeded',
      result: { updated: true },
      step,
    });

    expect(needsGoalProgressUpdate([work(1)])).toBe(true);
    expect(needsGoalProgressUpdate([work(1), progress(2)])).toBe(false);
    expect(needsGoalProgressUpdate([work(1), progress(2), work(3)])).toBe(true);
    expect(needsGoalProgressUpdate([work(1), progress(1)])).toBe(true);
  });
});
