import type { Trust } from '@assistant/core';
import type { AssistantTool, RegisteredTool, ToolFlags } from './types.js';

/**
 * Trust-scoped tool registry. Any externally triggered task loses private
 * owner reads and persistent writes; unknown senders also lose outward-facing
 * tools entirely. This is architectural, not prompt-level.
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
  toolsForTask(trust: Trust, tainted = false): AssistantTool[] {
    const untrusted = trust === 'unknown';
    const external = untrusted || trust === 'known';
    return [...this.tools.values()]
      .filter(
        ({ tool, flags }) =>
          (!untrusted || !flags.outwardFacing) &&
          (!external || tool.acceptsUntrustedInput) &&
          (!external ||
            (!flags.writesMemory &&
              !flags.confidentialRead &&
              !flags.writesWorkspace &&
              !flags.privateWrite)),
      )
      .map(({ tool }) => tool)
      .filter((tool) => !tainted || tool.acceptsUntrustedInput);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  resultIsUntrusted(name: string): boolean {
    return this.tools.get(name)?.flags.returnsUntrustedContent === true;
  }
}
