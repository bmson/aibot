import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { plannerContext } from './planner.js';

/**
 * Regression for the goal-clarification loop: repeated assistant questions
 * used to consume the whole planner budget, so the owner's short answers fell
 * out of context and the planner kept re-deriving 'clarify' from its own
 * questions.
 */
describe('planner context', () => {
  const longQuestion = `Before I proceed, I need to know: ${'target roles, location, salary. '.repeat(60)}`;

  it("keeps the owner's answers when the assistant's own questions are long", () => {
    const window: ModelMessage[] = [
      { role: 'assistant', content: longQuestion },
      { role: 'user', content: 'Remote or San Francisco' },
      { role: 'assistant', content: longQuestion },
      { role: 'user', content: 'You can apply autonomously' },
      { role: 'assistant', content: longQuestion },
    ] as ModelMessage[];

    const context = plannerContext(window);

    expect(context).toContain('Remote or San Francisco');
    expect(context).toContain('You can apply autonomously');
  });

  it('truncates assistant prose but never the owner turns', () => {
    const answer = 'Salary no less than 250'.repeat(40);
    const window: ModelMessage[] = [
      { role: 'assistant', content: longQuestion },
      { role: 'user', content: answer },
    ] as ModelMessage[];

    const context = plannerContext(window);

    expect(context).toContain(answer);
    expect(context).toContain('…');
    expect(context.length).toBeLessThan(longQuestion.length + answer.length);
  });
});
