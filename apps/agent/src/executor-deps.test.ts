import type { TaskRow } from '@assistant/db';
import type { InstalledModuleSet, ModuleChannel } from '@assistant/modules';
import { describe, expect, it } from 'vitest';
import type { AgentDeps } from './deps.js';
import { approvalNoticeEmail, executorDeps } from './executor-deps.js';

describe('approvalNoticeEmail', () => {
  const notice = approvalNoticeEmail([
    { shortCode: 'A7', summary: 'Create event "The Odyssey" 2026-07-23T18:00 and invite owner' },
  ]);

  it('names every pending approval with its code', () => {
    expect(notice).toContain('A7');
    expect(notice).toContain('The Odyssey');
  });

  it('states plainly that nothing has happened yet', () => {
    // The whole point of the parked notice: the owner must not read it as a
    // completion. This is the same failure the response contract exists to stop.
    expect(notice).toMatch(/nothing has happened yet/i);
  });

  it('does not invite an email reply, which cannot resolve an approval', () => {
    // Only sms-channel parses "YES A7". Telling the owner to reply to the email
    // would be an instruction the system silently drops.
    expect(notice).not.toMatch(/reply to this email/i);
    expect(notice).toMatch(/dashboard/i);
    expect(notice).toMatch(/text message/i);
  });

  it('lists each approval when several park together', () => {
    const many = approvalNoticeEmail([
      { shortCode: 'A8', summary: 'first' },
      { shortCode: 'A9', summary: 'second' },
    ]);
    expect(many).toContain('[A8] first');
    expect(many).toContain('[A9] second');
  });
});

/**
 * The channel fan-out semantics carried over from the hardcoded era: every
 * channel's configured-check runs before ANY channel delivers, delivery order
 * is composition order (email before sms), and the approval flow pings the
 * owner out-of-band before posting the in-thread notice.
 */
describe('executorDeps channel composition', () => {
  const calls: string[] = [];
  const channel = (name: string, over: Partial<ModuleChannel> = {}): ModuleChannel => ({
    deliverFinal: async () => {
      calls.push(`deliver:${name}`);
    },
    deliverApprovalNotice: async () => {
      calls.push(`notice:${name}`);
    },
    ...over,
  });
  const depsWith = (
    channels: ModuleChannel[],
    channelUnavailable: (taskType: string) => string | null = () => null,
  ): AgentDeps =>
    ({
      db: {},
      modules: {
        channels,
        ownerNotifier: {
          notifyOwner: async () => {
            calls.push('ping:owner');
          },
          notifyApprovals: async () => {
            calls.push('ping:approvals');
          },
        },
        emailObservers: [],
        jobUnavailable: () => null,
        channelUnavailable,
      } as unknown as InstalledModuleSet,
    }) as unknown as AgentDeps;
  const task = { id: 't1', type: 'email_triage', trust: 'owner' } as TaskRow;

  it('runs every assertDeliverable before any delivery', async () => {
    calls.length = 0;
    const throwing = channel('email', {
      assertDeliverable: () => {
        throw new Error('email final delivery is not configured');
      },
    });
    const deps = depsWith([throwing, channel('sms')]);
    await expect(executorDeps(deps).deliverFinal?.(task, 'answer')).rejects.toThrow(
      /email final delivery is not configured/,
    );
    // The failing check fired before EITHER channel delivered anything.
    expect(calls).toEqual([]);
  });

  it('delivers through every channel in composition order', async () => {
    calls.length = 0;
    const deps = depsWith([channel('email'), channel('sms')]);
    await executorDeps(deps).deliverFinal?.(task, 'answer');
    expect(calls).toEqual(['deliver:email', 'deliver:sms']);
  });

  it('pings the owner before posting the in-thread approval notice', async () => {
    calls.length = 0;
    const deps = depsWith([channel('email')]);
    await executorDeps(deps).notifyApproval?.(task, [
      { taskId: 't1', shortCode: 'A7', summary: 's' },
    ]);
    expect(calls).toEqual(['ping:approvals', 'notice:email']);
  });

  it('fails an owner-facing task loudly when its owning channel module is uninstalled', async () => {
    // With zero channels installed there is no assertDeliverable to fire, so
    // without the channelUnavailable guard the task would complete as done with
    // the answer silently undelivered.
    calls.length = 0;
    const deps = depsWith([], (type) =>
      type === 'email_triage'
        ? 'email_triage cannot be delivered because the google module is not installed'
        : null,
    );
    await expect(executorDeps(deps).deliverFinal?.(task, 'answer')).rejects.toThrow(
      /google module is not installed/,
    );
    expect(calls).toEqual([]);
  });

  it('does not block a non-owner task when a channel is absent', async () => {
    calls.length = 0;
    const unknownTask = { id: 't2', type: 'email_triage', trust: 'unknown' } as TaskRow;
    const deps = depsWith([], () => 'should not be consulted for non-owner tasks');
    await executorDeps(deps).deliverFinal?.(unknownTask, 'answer');
    expect(calls).toEqual([]); // no channels, nothing delivered, no throw
  });
});
