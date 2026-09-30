import { randomUUID } from 'node:crypto';
import type { AuditInvestigationRepository } from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerAuditTools } from './audit.js';

it('keeps owner audit evidence out of external task registries and taints quoted content', () => {
  const registry = registerAuditTools(new ToolRegistry(), {} as AuditInvestigationRepository);
  expect(registry.toolsForTask('owner').map((tool) => tool.name)).toContain('audit.read');
  for (const trust of ['known', 'unknown'] as const)
    expect(registry.toolsForTask(trust)).toEqual([]);
  expect(registry.resultIsUntrusted('audit.read')).toBe(true);
  expect(registry.resultIsUntrusted('audit.read_field')).toBe(true);
});
it('scopes reads to the invoking owner and fails closed for missing records', async () => {
  const task = vi.fn(async () => null);
  const read = vi.fn(async () => []);
  const registry = registerAuditTools(new ToolRegistry(), { task, read });
  const tool = registry.get('audit.read')?.tool;
  const taskId = randomUUID();
  expect(await tool?.execute({ taskId }, { agentId: 'owner-A' } as ToolContext)).toEqual({
    error: 'Audit record not found.',
  });
  expect(task).toHaveBeenCalledWith('owner-A', taskId);
  expect(read).not.toHaveBeenCalled();
});
