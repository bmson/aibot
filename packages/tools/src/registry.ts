import type { Trust } from '@assistant/core';
import type { AssistantTool, RegisteredTool, ToolFlags } from './types.js';

/**
 * Trust-scoped tool registry. Tasks triggered by untrusted content get a
 * reduced registry: no outward-facing tools, no memory-writing tools — an
 * injected email cannot call gmail.send; it can only propose drafts a human
 * opens. This is architectural, not prompt-level.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: AssistantTool, flags: ToolFlags = {}): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, { tool, flags });
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** The tool set exposed to the model for a task with the given trust. */
  toolsForTask(trust: Trust): AssistantTool[] {
    const untrusted = trust === 'unknown';
    return [...this.tools.values()]
      .filter(({ flags }) => !untrusted || (!flags.outwardFacing && !flags.writesMemory))
      .map(({ tool }) => tool);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }
}
