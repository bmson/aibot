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

  /**
   * The tool set exposed to the model for a task with the given trust.
   *
   * Externally triggered tasks (known/unknown) lose `acceptsUntrustedInput:
   * false` tools outright — for them it is a forbidden-by-construction boundary.
   *
   * A privileged owner/assistant task whose context has been tainted keeps them.
   * Removing a capability the owner is standing right there asking for does not
   * make the action safer; it makes it invisible. The model cannot see why the
   * tool vanished, so it invents a reason, refuses, and offers the owner a
   * copy-paste workaround — while the dispatcher's `taintNeedsApproval` gate
   * would have produced an approval card showing the exact arguments. Taint
   * therefore constrains *how* these tools run (approval, never autonomous),
   * not *whether* the model can see them.
   */
  toolsForTask(trust: Trust): AssistantTool[] {
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
      .map(({ tool }) => tool);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  resultIsUntrusted(name: string): boolean {
    return this.tools.get(name)?.flags.returnsUntrustedContent === true;
  }
}
