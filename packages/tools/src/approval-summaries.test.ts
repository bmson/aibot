import { describe, expect, it } from 'vitest';
import type { GoogleClient } from './google/client.js';
import {
  registerApplicationTools,
  registerBrowserTools,
  registerBuiltinTools,
  registerCalendarTools,
  registerDocsTools,
  registerDriveTools,
  registerGmailTools,
  registerSheetsTools,
  registerSlidesTools,
  registerSmsTools,
  registerWatchTools,
} from './index.js';
import { ToolRegistry } from './registry.js';
import type { RegisteredTool } from './types.js';

// The registrars only DEFINE tools; the clients are never called at
// registration time, so trivial fakes are enough to assemble the full set.
const fakeClient = { api: async () => ({}) } as unknown as GoogleClient;

function fullRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, {
    embed: async (texts: string[]) => texts.map(() => [0]),
    workspace: {
      read: async () => '',
      write: async () => {},
      list: async () => [],
    } as never,
  });
  registerBrowserTools(registry, {
    plan: async () => ({ rung: 'fetch', reason: '', url: '' }) as never,
    launcher: {} as never,
    callbackUrl: 'https://example.test/cb',
  });
  registerWatchTools(registry);
  registerGmailTools(registry, {
    client: fakeClient,
    botEmail: 'bot@example.com',
    botName: 'AI Bot',
    prepareOutbound: async (text: string) => ({ text }),
  });
  registerCalendarTools(registry, {
    client: fakeClient,
    botEmail: 'bot@example.com',
    ownerEmail: 'owner@example.com',
  });
  registerDocsTools(registry, {
    client: fakeClient,
    botEmail: 'bot@example.com',
    ownerEmail: 'owner@example.com',
  });
  registerDriveTools(registry, {
    client: fakeClient,
    workspace: { write: async () => {} } as never,
  });
  registerSheetsTools(registry, { client: fakeClient, ownerEmail: 'owner@example.com' });
  registerApplicationTools(registry, { client: fakeClient });
  registerSlidesTools(registry, { client: fakeClient, ownerEmail: 'owner@example.com' });
  registerSmsTools(registry, {
    sender: { send: async () => ({ sid: 'x' }) } as never,
    ownerPhone: '+10000000000',
    prepareOutbound: async (text: string) => ({ text }),
  });
  return registry;
}

/**
 * A tool that reaches an approval card in a consequential way must show WHAT is
 * being approved. Without a payload-bearing approvalSummary the owner sees the
 * generic fallback — "Allow the assistant to gmail send" — which is exactly the
 * fidelity gap that makes SMS one-tap unsafe. This is the enforceable contract.
 */
function isConsequentiallyGated({ tool, flags }: RegisteredTool): boolean {
  const staticApproval = typeof tool.risk !== 'function' && tool.risk === 'approval';
  return Boolean(
    staticApproval || flags.outwardFacing || flags.networkEgress || flags.writesMemory,
  );
}

describe('approval summary coverage', () => {
  const registry = fullRegistry();
  const all = registry.all();

  it('every consequentially-gated tool defines a payload-bearing approvalSummary', () => {
    const missing = all
      .filter(isConsequentiallyGated)
      .filter(({ tool }) => typeof tool.approvalSummary !== 'function')
      .map(({ tool }) => tool.name);
    expect(missing).toEqual([]);
  });

  it('one-tap SMS is never offered for ANY privileged tool', () => {
    // Must mirror ToolRegistry.toolsForTask's external strip set exactly, or a
    // tool carrying only an omitted flag fails open to a spoofable SMS.
    for (const { tool, flags } of all) {
      if (
        flags.outwardFacing ||
        flags.networkEgress ||
        flags.writesMemory ||
        flags.writesWorkspace ||
        flags.privateWrite ||
        flags.confidentialRead ||
        flags.blanketAllowIneligible
      ) {
        expect(registry.smsApprovable(tool.name)).toBe(false);
      }
    }
  });

  it('the known fail-open bypass tools are dashboard-only (regression)', () => {
    // applications.watch_confirmation is privateWrite-only; goals.create is
    // durable behaviour-shaping state. Both were one-tap SMS-approvable before
    // the smsApprovable flag set was widened.
    expect(registry.smsApprovable('applications.watch_confirmation')).toBe(false);
    expect(registry.smsApprovable('goals.create')).toBe(false);
  });

  it('a tool with no approvalSummary is never SMS-approvable', () => {
    for (const { tool } of all) {
      if (typeof tool.approvalSummary !== 'function') {
        expect(registry.smsApprovable(tool.name)).toBe(false);
      }
    }
  });
});
