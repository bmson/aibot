import { type Config, loadConfig, resetConfigForTest } from '@assistant/config';
import type { Db } from '@assistant/db';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, describe, expect, it } from 'vitest';
import { documentsModule } from './documents/module.js';
import { remindersModule } from './reminders/module.js';
import { installModules } from './runtime.js';
import type { ModulePlatformContext } from './runtime-kit.js';
import { watchesModule } from './watches/module.js';

/**
 * Only tool-registering modules are installed here, so the unused halves of the
 * platform context are never dereferenced.
 */
function contextFor(config: Config): ModulePlatformContext {
  return {
    config,
    db: {} as Db,
    registry: new ToolRegistry(),
    router: {} as ModulePlatformContext['router'],
    workspace: {} as ModulePlatformContext['workspace'],
    workspacePrefix: 'workspace/test',
    workspaceRoot: '/tmp/assistant-test',
    repoRoot: '/tmp/assistant-test',
  };
}

describe('installModules', () => {
  afterEach(() => resetConfigForTest());

  it('installs only the modules the configuration selects', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([remindersModule, watchesModule], context);

    expect(installed.enabled).toEqual(['reminders']);
    expect(context.registry.get('reminder.create')).toBeDefined();
    expect(context.registry.get('watch.create')).toBeUndefined();
  });

  it('registers nothing at all for a minimal installation', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'minimal' }));
    const installed = installModules([remindersModule, watchesModule], context);

    expect(installed.enabled).toEqual([]);
    expect(context.registry.all()).toHaveLength(0);
  });

  it('reports no exports for a module that is not installed', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'minimal' }));
    const installed = installModules([documentsModule], context);

    expect(installed.exportsOf(documentsModule)).toBeUndefined();
  });

  it('completes a queued job whose module was removed', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([documentsModule, remindersModule], context);

    expect(installed.jobUnavailable('documents.extract')).toBe(
      'documents.extract skipped because the documents module is disabled',
    );
    expect(installed.jobUnavailable('memory.extract')).toBeNull();
  });

  it('runs a job normally while its module is installed', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'documents' }));
    const installed = installModules([documentsModule], context);

    expect(installed.jobUnavailable('documents.extract')).toBeNull();
  });
});

describe('composition as a restrictor', () => {
  afterEach(() => resetConfigForTest());

  it('warns when configuration names a module this build does not contain', () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders,watches' }));
      installModules([remindersModule], context);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('watches');
    expect(warnings[0]).toContain('assistant.config.ts');
  });

  it('installs the intersection of the composition and the configuration', () => {
    const context = contextFor(loadConfig({ ASSISTANT_MODULES: 'reminders' }));
    const installed = installModules([remindersModule, watchesModule], context);
    expect(installed.enabled).toEqual(['reminders']);
  });
});
