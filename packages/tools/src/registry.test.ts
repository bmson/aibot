import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('strips outward-facing and memory-writing tools for untrusted-trigger tasks', () => {
    const registry = new ToolRegistry()
      .register(fakeTool('gmail.search'))
      .register(fakeTool('gmail.send'), { outwardFacing: true })
      .register(fakeTool('memory.save'), { writesMemory: true })
      .register(fakeTool('web.fetch'));

    const untrusted = registry.toolsForTask('unknown').map((t) => t.name);
    expect(untrusted).toEqual(['gmail.search', 'web.fetch']);

    const owner = registry.toolsForTask('owner').map((t) => t.name);
    expect(owner).toHaveLength(4);
  });

  it('assistant-trust tasks keep the full registry (internal provenance, same outbound gates)', () => {
    const registry = new ToolRegistry()
      .register(fakeTool('gmail.send'), { outwardFacing: true })
      .register(fakeTool('memory.save'), { writesMemory: true });
    expect(registry.toolsForTask('assistant')).toHaveLength(2);
  });
});
