import type { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

/**
 * Register a tool while keeping its argument type tied to its own schema.
 *
 * `ToolRegistry` stores tools under one erased type; this preserves the precise
 * `execute` signature at each definition site, so a tool body still sees its
 * own parsed arguments.
 */
export function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
): void {
  registry.register(tool as unknown as AssistantTool, flags);
}
