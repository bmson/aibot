import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerGmailTools } from './gmail.js';

const outbound = {
  to: ['person@example.com'],
  subject: 'Research summary',
  body: 'Quoted public-web findings',
  register: 'email_professional' as const,
};

function context(tainted: boolean): ToolContext {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    trust: 'owner',
    tainted,
    db: {} as ToolContext['db'],
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  };
}

describe('Gmail outbound security', () => {
  it('allows owner-led external-content email only through an outward approval boundary', () => {
    const registry = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
    });
    const registered = registry.get('gmail.send');

    expect(registered?.tool.acceptsUntrustedInput).toBe(true);
    expect(registered?.tool.risk).toBe('approval');
    expect(registered?.flags).toMatchObject({
      outwardFacing: true,
      networkEgress: true,
      blanketAllowIneligible: true,
    });
    expect(registry.toolsForTask('unknown', true).map((tool) => tool.name)).not.toContain(
      'gmail.send',
    );
    expect(registry.toolsForTask('owner', true).map((tool) => tool.name)).toContain('gmail.send');
  });

  it('never sends tainted content through the private voice-rewrite context', async () => {
    const prepareOutbound = vi.fn(async () => ({ text: 'voice rewritten' }));
    const registry = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
      prepareOutbound,
    });
    const prepare = registry.get('gmail.send')?.tool.prepare;
    expect(prepare).toBeDefined();
    if (!prepare) return;

    await expect(prepare(outbound, context(true))).resolves.toEqual(outbound);
    expect(prepareOutbound).not.toHaveBeenCalled();

    await expect(prepare(outbound, context(false))).resolves.toMatchObject({
      body: 'voice rewritten',
    });
    expect(prepareOutbound).toHaveBeenCalledOnce();
  });
});
