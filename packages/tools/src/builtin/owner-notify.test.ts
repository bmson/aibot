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

  it('pings through the out-of-band leg when one is configured, and survives its failure', async () => {
    const post = vi.fn(async () => ({ conversationId: 'owner-chat' }));
    const notifyOwner = vi.fn(async () => {});
    const tool = registerPortableOwnerNotifyTool(new ToolRegistry(), { post, notifyOwner }).get(
      'owner.notify',
    )?.tool;
    if (!tool) throw new Error('Missing portable owner.notify');
    const ctx = {
      agentId: 'owner',
      taskId: 'task',
      conversationId: null,
    } as unknown as ToolContext;
    expect(await tool.execute({ message: 'Leave now', ping: true }, ctx)).toMatchObject({
      pinged: true,
    });
    expect(notifyOwner).toHaveBeenCalledWith({
      text: 'Leave now',
      taskId: 'task',
      urgency: 'ambient',
    });
    expect(await tool.execute({ message: 'No ping' }, ctx)).toMatchObject({ pinged: false });
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    notifyOwner.mockRejectedValueOnce(new Error('radio down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await tool.execute({ message: 'Leave now', ping: true }, ctx)).toMatchObject({
      notified: true,
      pinged: false,
    });
  });
});
