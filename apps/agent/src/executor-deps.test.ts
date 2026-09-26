import type { TaskRow } from '@assistant/db';
import type { InstalledModuleSet, ModuleChannel } from '@assistant/modules';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentDeps,
  approvalSummaryNotice,
  pinnedMemoryEmbed,
  shouldMirrorIntoPrimary,
} from './deps.js';
import { approvalNoticeEmail, executorDeps } from './executor-deps.js';

describe('Firestore memory embedding provenance', () => {
  it('accepts vendor-qualified OpenRouter model IDs', async () => {
    const role = vi.fn().mockResolvedValue({ primaryModel: 'openai/text-embedding-3-small' });
    const embed = vi.fn().mockResolvedValue([[1, 0, 0]]);
    const pinned = pinnedMemoryEmbed(
      {
        provider: 'openrouter',
        model: 'openai/text-embedding-3-small',
        dimensions: 1536,
        revision: '1',
      },
      { role },
      embed,
    );

    await expect(pinned(['private fact'])).resolves.toEqual([[1, 0, 0]]);
    expect(embed).toHaveBeenCalledOnce();
  });

  it('refuses a changed embedding role before requesting a vector', async () => {
    const role = vi.fn().mockResolvedValue({ primaryModel: 'openai/text-embedding-3-small' });
    const embed = vi.fn().mockResolvedValue([[1, 0, 0]]);
    const pinned = pinnedMemoryEmbed(
      { provider: 'google', model: 'gemini-embedding-001', dimensions: 1536, revision: '1' },
      { role },
      embed,
    );

    await expect(pinned(['private fact'])).rejects.toThrow(
      'Firestore memory embedding role must use google/gemini-embedding-001',
    );
    expect(embed).not.toHaveBeenCalled();
    role.mockResolvedValue({ primaryModel: 'google/gemini-embedding-001' });
    await expect(pinned(['private fact'])).resolves.toEqual([[1, 0, 0]]);
    expect(embed).toHaveBeenCalledOnce();
  });
});

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

describe('dashboard notice mirroring', () => {
  it('does not mirror a notice back into the primary conversation that already owns it', () => {
    expect(shouldMirrorIntoPrimary('primary-chat', 'primary-chat')).toBe(false);
  });

  it('still mirrors background and work-thread notices into the primary conversation', () => {
    expect(shouldMirrorIntoPrimary('work-chat', 'primary-chat')).toBe(true);
    expect(shouldMirrorIntoPrimary(null, 'primary-chat')).toBe(true);
  });
});

describe('approvalSummaryNotice', () => {
  it('explains the task purpose and count without leaking approval codes or payloads', () => {
    expect(
      approvalSummaryNotice([
        { purpose: 'Find an open cafe nearby' },
        { purpose: 'Find an open cafe nearby' },
      ]),
    ).toEqual({
      text: 'Approval needed to continue: Find an open cafe nearby\n2 actions are waiting for review in Approvals.',
      extraParts: [
        { type: 'approval-summary', purpose: 'Find an open cafe nearby', approvalCount: 2 },
      ],
    });
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
      config: { PERSISTENCE_DRIVER: 'postgres' },
      db: {},
      // The composition root hands agentServices the policy-gated phone legs
      // as a unit; the fixture stands in for it directly.
      outOfBandNotifier: {
        notifyOwner: async () => {
          calls.push('ping:owner');
        },
        notifyApprovals: async () => {
          calls.push('ping:approvals');
        },
      },
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

describe('executorDeps code-job availability', () => {
  const depsFor = (driver: 'postgres' | 'firestore', moduleOwned: string | null = null) =>
    ({
      config: { PERSISTENCE_DRIVER: driver, FIRESTORE_AGENT_ID: 'agent' },
      db: {},
      firestoreStore: {},
      outOfBandNotifier: { notifyOwner: async () => {}, notifyApprovals: async () => {} },
      modules: {
        channels: [],
        ownerNotifier: { notifyOwner: async () => {}, notifyApprovals: async () => {} },
        emailObservers: [],
        jobUnavailable: () => moduleOwned,
      } as unknown as InstalledModuleSet,
    }) as unknown as AgentDeps;

  it('completes SQL-only jobs benignly under Firestore and keeps portable ones', () => {
    const jobs = executorDeps(depsFor('firestore'));
    expect(jobs.jobUnavailable?.('memory.graph_date_backfill')).toBe(
      'memory.graph_date_backfill skipped because it is not yet available on Firestore persistence',
    );
    expect(jobs.jobUnavailable?.('dream.run')).toBeNull();
    expect(jobs.jobUnavailable?.('memory.consolidate')).toBeNull();
    expect(jobs.jobUnavailable?.('reminder.notify')).toBeNull();
  });

  it('leaves every job available on PostgreSQL and prefers the module owner message', () => {
    expect(executorDeps(depsFor('postgres')).jobUnavailable?.('dream.run')).toBeNull();
    const moduleOff = executorDeps(depsFor('firestore', 'documents.process: module off'));
    expect(moduleOff.jobUnavailable?.('documents.process')).toBe('documents.process: module off');
  });
});
