import { describe, expect, it } from 'vitest';
import { isGoalWorkEvidenceTool } from './goal-evidence.js';

describe('isGoalWorkEvidenceTool', () => {
  it.each(['web.fetch', 'browser.execute', 'gmail.search', 'docs.create'])(
    'accepts verified work from %s',
    (toolName) => expect(isGoalWorkEvidenceTool(toolName)).toBe(true),
  );

  it.each(['goals.update_progress', 'goals.list', 'workspace.list', 'browser.plan'])(
    'does not let %s prove its own progress',
    (toolName) => expect(isGoalWorkEvidenceTool(toolName)).toBe(false),
  );
});
