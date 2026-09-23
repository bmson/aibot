import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerPortableOwnerNotifyTool } from './owner-notify.js';

describe('portable owner.notify', () => {
  it('posts to the owner chat without SQL and reports unavailable phone delivery honestly', async () => {
    const post = vi.fn(async () => ({ conversationId: 'owner-chat' }));
    const registry = registerPortableOwnerNotifyTool(new ToolRegistry(), { post });
    expect(registry.toolsForTask('unknown')).toEqual([]);
    expect(registry.get('owner.notify')?.flags.ownerVisibleOnly).toBe(true);
    const tool = registry.get('owner.notify')?.tool;
    if (!tool) throw new Error('Missing portable owner.notify');
    const ctx = {
      agentId: 'owner',
      taskId: 'task',
      conversationId: 'owner-chat',
      trust: 'assistant',
      db: new Proxy(
        {},
        {
          get() {
            throw new Error('PostgreSQL must be unavailable');
          },
        },
      ),
    } as ToolContext;
    expect(await tool.execute({ message: 'Please check in', ping: true }, ctx)).toEqual({
      notified: true,
      conversationId: 'owner-chat',
      pinged: false,
    });
    expect(post).toHaveBeenCalledWith({
      agentId: 'owner',
      taskId: 'task',
      conversationId: 'owner-chat',
      text: 'Please check in',
    });
  });
});
