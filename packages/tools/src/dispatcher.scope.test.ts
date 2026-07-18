import type { Db } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolDispatcher } from './dispatcher.js';
import { ToolRegistry } from './registry.js';

describe('ToolDispatcher task scope', () => {
  it('does not expose mission.update outside a real mission work session', () => {
    const registry = new ToolRegistry()
      .register({
        name: 'mission.update',
        description: 'update mission',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async () => ({ updated: true }),
      })
      .register({
        name: 'web.fetch',
        description: 'fetch web page',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async () => ({}),
      });
    const dispatcher = new ToolDispatcher({} as Db, registry);

    expect(dispatcher.toolDefs('owner').map((tool) => tool.name)).toEqual(['web.fetch']);
    expect(
      dispatcher.toolDefs('owner', false, { isMissionSession: true }).map((tool) => tool.name),
    ).toEqual(['mission.update', 'web.fetch']);
  });
});
