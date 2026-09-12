import type {
  ApprovalPolicy,
  ApprovalPolicyRepository,
} from '@assistant/core/workflow/approval-policies';
import { expect, it, vi } from 'vitest';
import { matchPolicies } from './policies.js';
import type { ToolContext } from './types.js';

it('reads enabled owner/tool rules and preserves deny precedence through the portable adapter', async () => {
  const policy = (id: string, effect: string, templateKey: string): ApprovalPolicy => ({
    id,
    agentId: 'owner',
    toolName: 'gmail.send',
    effect,
    templateKey,
    match: { recipient: 'recipient@example.com' },
    enabled: true,
    version: 1,
    createdVia: 'settings',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const list = vi.fn(async () => [
    policy('allow', 'allow', 'gmail.send.to_recipient'),
    policy('unknown', 'deny', 'unrecognized.template'),
    policy('deny', 'deny', 'gmail.send.to_recipient'),
  ]);
  const repository: ApprovalPolicyRepository = {
    kind: 'approval-policy-repository',
    list,
    setEnabled: async () => false,
    delete: async () => false,
  };
  const result = await matchPolicies(repository, {
    agentId: 'owner',
    toolName: 'gmail.send',
    args: { to: ['recipient@example.com'] },
    ctx: { trust: 'owner' } as ToolContext,
  });
  expect(list).toHaveBeenCalledWith('owner', { toolName: 'gmail.send', enabledOnly: true });
  expect(result?.policy.id).toBe('deny');
  expect(result?.effect).toBe('deny');
});
