import type { TaskRow } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { taskBudgetPermissionRequest } from './notices.js';

describe('taskBudgetPermissionRequest', () => {
  it('proposes a bounded, runtime-calculated task cap and asks permission', () => {
    const task = {
      id: '090db434-02f8-4d4e-8849-2b9cc3df1285',
      budgetUsdLimit: '0.2500',
      spentUsd: '0.106100',
    } as TaskRow;

    const request = taskBudgetPermissionRequest(
      task,
      'task budget cannot cover this (spent $0.1061 + held $0.0000 + est $0.1898 > cap $0.2750 including owner-reply carve-out)',
    );

    expect(request.part).toMatchObject({
      type: 'budget-request',
      taskId: task.id,
      currentBudgetUsd: 0.25,
      proposedBudgetUsd: 0.5,
      spentUsd: 0.1061,
    });
    expect(request.text).toContain('permission');
    expect(request.text).toContain("won't increase the budget without your approval");
  });
});
