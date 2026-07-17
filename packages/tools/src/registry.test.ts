import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerCalendarTools } from './google/calendar.js';
import { registerGmailTools } from './google/gmail.js';
import { ToolRegistry } from './registry.js';
import type { AssistantTool } from './types.js';

function fakeTool(name: string): AssistantTool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: z.object({}),
    risk: 'autonomous',
    acceptsUntrustedInput: true,
    execute: async () => ({}),
  };
}

describe('ToolRegistry', () => {
  it('rejects duplicate registration', () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('gmail.search'));
    expect(() => registry.register(fakeTool('gmail.search'))).toThrow(/already registered/);
  });

  it('strips side effects and confidential reads for untrusted-trigger tasks', () => {
    const registry = new ToolRegistry()
      .register(fakeTool('gmail.search'), { confidentialRead: true })
      .register(fakeTool('gmail.send'), { outwardFacing: true })
      .register(fakeTool('memory.save'), { writesMemory: true })
      .register(fakeTool('workspace.write'), { writesWorkspace: true })
      .register(fakeTool('workspace.read'), { confidentialRead: true })
      .register(fakeTool('web.fetch'));

    const untrusted = registry.toolsForTask('unknown').map((t) => t.name);
    expect(untrusted).toEqual(['web.fetch']);

    const owner = registry.toolsForTask('owner').map((t) => t.name);
    expect(owner).toHaveLength(6);
  });

  it('assistant-trust tasks keep the full registry (internal provenance, same outbound gates)', () => {
    const registry = new ToolRegistry()
      .register(fakeTool('gmail.send'), { outwardFacing: true })
      .register(fakeTool('memory.save'), { writesMemory: true });
    expect(registry.toolsForTask('assistant')).toHaveLength(2);
  });

  it('keeps confidential owner data away from known external senders too', () => {
    const registry = new ToolRegistry()
      .register(fakeTool('memory.recall'), { confidentialRead: true })
      .register(fakeTool('workspace.write'), { writesWorkspace: true })
      .register(
        { ...fakeTool('gmail.send'), acceptsUntrustedInput: false },
        { outwardFacing: true },
      );
    expect(registry.toolsForTask('known').map((tool) => tool.name)).toEqual([]);
  });

  it('hides tools that reject untrusted-derived arguments after context taint', () => {
    const sensitive = { ...fakeTool('sensitive.action'), acceptsUntrustedInput: false };
    const registry = new ToolRegistry().register(sensitive).register(fakeTool('web.fetch'));
    expect(registry.toolsForTask('owner', true).map((tool) => tool.name)).toEqual(['web.fetch']);
  });

  it('marks Gmail and calendar reads as confidential capabilities', () => {
    const registry = new ToolRegistry();
    registerGmailTools(registry, {
      client: {} as Parameters<typeof registerGmailTools>[1]['client'],
      botEmail: 'bot@example.com',
    });
    registerCalendarTools(registry, {
      client: {} as Parameters<typeof registerCalendarTools>[1]['client'],
      botEmail: 'bot@example.com',
      ownerEmail: 'owner@example.com',
    });

    const unknown = registry.toolsForTask('unknown').map((tool) => tool.name);
    expect(unknown).not.toContain('gmail.search');
    expect(unknown).not.toContain('gmail.read_thread');
    expect(unknown).not.toContain('gmail.create_draft');
    expect(unknown).not.toContain('calendar.availability');
    expect(unknown).not.toContain('calendar.list_events');
  });
});
