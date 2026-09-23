import type { ApplicationChatPersistence } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { getPrimaryConversationId } from './shell.js';

describe('application shell chat bootstrap', () => {
  it('uses the supplied chat persistence without opening PostgreSQL', async () => {
    const persistence = {
      kind: 'application-chat-persistence',
      resolveAgent: vi.fn().mockResolvedValue({ id: 'agent-1' }),
      getOrCreatePrimaryConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
    } as unknown as ApplicationChatPersistence;

    await expect(getPrimaryConversationId(persistence)).resolves.toBe('conversation-1');
    expect(persistence.resolveAgent).toHaveBeenCalledOnce();
    expect(persistence.getOrCreatePrimaryConversation).toHaveBeenCalledWith('agent-1');
  });
});
