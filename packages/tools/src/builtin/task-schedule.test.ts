import type { TaskRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerPortableTaskTools } from './task-schedule.js';

describe('portable task tools', () => {
  it('schedules through the task repository without touching SQL and preserves taint', async () => {
    const createScheduledFollowUp = vi.fn(async () => ({
      created: true,
      task: { id: 'child-task' },
    }));
    const registry = registerPortableTaskTools(new ToolRegistry(), {
      tasks: { createScheduledFollowUp } as unknown as TaskRepository,
    });
    const tool = registry.get('task.schedule')?.tool;
    if (!tool) throw new Error('Missing task.schedule');
    const now = new Date('2026-09-23T12:00:00.000Z');
    const ctx = {
      agentId: 'agent-1',
      taskId: 'parent-task',
      conversationId: 'conversation-1',
      trust: 'owner',
      tainted: true,
      now: () => now,
      db: new Proxy(
        {},
        {
          get() {
            throw new Error('Unexpected SQL access');
          },
        },
      ),
    } as ToolContext;

    await expect(
      tool.execute(
        { when: '2026-09-24T12:00:00.000Z', instruction: 'Check the release status' },
        ctx,
      ),
    ).resolves.toEqual({
      scheduled: true,
      taskId: 'child-task',
      runAfter: '2026-09-24T12:00:00.000Z',
    });
    expect(createScheduledFollowUp).toHaveBeenCalledWith({
      parentTaskId: 'parent-task',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      instruction: 'Check the release status',
      runAfter: new Date('2026-09-24T12:00:00.000Z'),
      trust: 'owner',
      tainted: true,
    });
  });

  it('rejects scheduling in the past before calling persistence', async () => {
    const createScheduledFollowUp = vi.fn();
    const registry = registerPortableTaskTools(new ToolRegistry(), {
      tasks: { createScheduledFollowUp } as unknown as TaskRepository,
    });
    const tool = registry.get('task.schedule')?.tool;
    if (!tool) throw new Error('Missing task.schedule');
    const ctx = {
      agentId: 'agent-1',
      taskId: 'parent-task',
      trust: 'assistant',
      tainted: false,
      now: () => new Date('2026-09-23T12:00:00.000Z'),
    } as ToolContext;

    await expect(
      tool.execute(
        { when: '2026-09-23T11:00:00.000Z', instruction: 'Check the release status' },
        ctx,
      ),
    ).rejects.toThrow('when must be in the future');
    expect(createScheduledFollowUp).not.toHaveBeenCalled();
  });
});
