import { describe, expect, it } from 'vitest';
import { rememberedApprovalPolicy } from './approvals.js';

describe('rememberedApprovalPolicy', () => {
  it('builds the single supported recipient-scoped email rule', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'gmail.send', { to: ['Friend@Example.com'] }),
    ).toEqual({
      agentId: 'agent-id',
      toolName: 'gmail.send',
      templateKey: 'gmail.send.to_recipient',
      match: { recipient: 'friend@example.com' },
      effect: 'allow',
    });
  });

  it('rejects ambiguous recipients', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'gmail.send', {
        to: ['one@example.com', 'two@example.com'],
      }),
    ).toBeNull();
  });

  it('never creates the rule for another tool', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'sms.send', { to: ['friend@example.com'] }),
    ).toBeNull();
  });
});
