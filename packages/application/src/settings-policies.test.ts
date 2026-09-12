import type { ApprovalPolicyRepository } from '@assistant/core/workflow/approval-policies';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteApprovalPolicy,
  getApprovalPolicySettings,
  setApprovalPolicyEnabled,
} from './settings.js';

describe('owner-scoped policy settings', () => {
  it('passes the configured owner to every repository operation', async () => {
    const list = vi.fn(async () => []);
    const setEnabled = vi.fn(async () => false);
    const remove = vi.fn(async () => false);
    const policies: ApprovalPolicyRepository = {
      kind: 'approval-policy-repository',
      list,
      setEnabled,
      delete: remove,
    };
    const store = { agentId: 'owner-a', policies };
    expect(await getApprovalPolicySettings(store)).toEqual([]);
    await setApprovalPolicyEnabled(store, 'foreign-policy', true);
    await deleteApprovalPolicy(store, 'foreign-policy');
    expect(list).toHaveBeenCalledWith('owner-a', undefined);
    expect(setEnabled).toHaveBeenCalledWith('owner-a', 'foreign-policy', true);
    expect(remove).toHaveBeenCalledWith('owner-a', 'foreign-policy');
  });
});
