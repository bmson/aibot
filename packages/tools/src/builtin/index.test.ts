import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerBuiltinTools } from './index.js';

describe('builtin trust capabilities', () => {
  it('does not expose owner-private reads or workspace writes to unknown tasks', () => {
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const unknown = registry.toolsForTask('unknown').map((tool) => tool.name);

    expect(unknown).not.toContain('memory.recall');
    expect(unknown).not.toContain('conversations.search');
    expect(unknown).not.toContain('goals.list');
    expect(unknown).not.toContain('workspace.read');
    expect(unknown).not.toContain('workspace.list');
    expect(unknown).not.toContain('workspace.write');
    expect(unknown).not.toContain('owner.notify');
    // Egress is denied to strangers too: a DKIM-valid unknown sender must not
    // drive HTTP requests or paid searches from the owner's IP.
    expect(unknown).not.toContain('web.fetch');
    expect(registry.toolsForTask('known').map((tool) => tool.name)).toContain('web.fetch');
  });

  it('lets mission/goal progress writers run under taint without an approval', () => {
    // Regression: a mission/goal work session almost always reads untrusted
    // content before it can summarise progress. Taint no longer strips tools
    // from a privileged registry, so availability alone is not the property
    // worth pinning — acceptsUntrustedInput is. It is what keeps these two off
    // the dispatcher's taintNeedsApproval path, so the loop can record progress
    // without prompting the owner on every step instead of silently repeating
    // step one forever.
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const owner = registry.toolsForTask('owner').map((tool) => tool.name);

    expect(owner).toContain('mission.update');
    expect(owner).toContain('goals.update_progress');
    expect(registry.get('mission.update')?.tool.acceptsUntrustedInput).toBe(true);
    expect(registry.get('goals.update_progress')?.tool.acceptsUntrustedInput).toBe(true);
  });
});
