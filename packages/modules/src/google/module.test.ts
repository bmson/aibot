import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { Db } from '@assistant/db';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModulePlatformContext } from '../platform.js';
import { smsModule } from '../sms/module.js';
import { googleModule } from './module.js';

function contextFor(): ModulePlatformContext {
  return {
    config: loadConfig({ ASSISTANT_MODULES: 'google,sms' }),
    db: {} as Db,
    registry: new ToolRegistry(),
    router: {} as ModulePlatformContext['router'],
    workspace: {} as ModulePlatformContext['workspace'],
    workspacePrefix: 'workspace/test',
    workspaceRoot: '/tmp/assistant-test',
    repoRoot: '/tmp/assistant-test',
  };
}

/**
 * The least-pinned relocation regression: a module missing credentials skips
 * TOOL registration but must still return its full hook set — routes answered
 * (with their own self-reported guards) even before `pnpm auth:bot`, exactly
 * as when they were hardcoded in the agent. A create() that forgets this
 * would 404 production webhooks while every auth test stays green.
 */
describe('unconfigured channel modules still hook the platform', () => {
  afterEach(() => resetConfigForTest());

  it('google returns every hook with no credentials', () => {
    const context = contextFor();
    const runtime = googleModule.create(context);

    expect(context.registry.all()).toHaveLength(0); // no tools without credentials
    expect(runtime.hooks?.webhooks?.map((route) => route.path)).toEqual(['/gmail/pubsub']);
    expect(runtime.hooks?.internalRoutes?.map((route) => route.path)).toEqual([
      '/gmail/watch',
      '/gmail/sync',
    ]);
    expect(runtime.hooks?.ticks?.map((tick) => tick.name)).toEqual(['email-sync']);
    expect(runtime.hooks?.sweepSteps?.map((step) => step.reportKey)).toEqual(['expiredWatches']);
    expect(runtime.hooks?.taskHandlers?.map((handler) => handler.kind)).toEqual([
      'application_confirmation',
      'application_confirmation_ambiguous',
    ]);
    expect(runtime.hooks?.channel).toBeDefined();
  });

  it('sms returns its channel, notifier, and webhook with no credentials', () => {
    const context = contextFor();
    const runtime = smsModule.create(context);

    expect(context.registry.all()).toHaveLength(0);
    expect(runtime.hooks?.webhooks?.map((route) => route.path)).toEqual(['/twilio/sms']);
    expect(runtime.hooks?.channel).toBeDefined();
    expect(runtime.hooks?.ownerNotifier).toBeDefined();
  });
});
