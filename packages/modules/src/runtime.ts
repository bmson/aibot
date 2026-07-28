import { type AssistantModule, isModuleEnabled } from '@assistant/config';
import { browserModule } from './browser/module.js';
import { codeModule } from './code/module.js';
import { documentsModule } from './documents/module.js';
import { googleModule } from './google/module.js';
import { remindersModule } from './reminders/module.js';
import type { ModuleDefinition, ModulePlatformContext } from './runtime-kit.js';
import { searchModule } from './search/module.js';
import { smsModule } from './sms/module.js';
import { watchesModule } from './watches/module.js';

export { browserModule } from './browser/module.js';
export { codeModule } from './code/module.js';
export { documentsModule } from './documents/module.js';
export { googleModule, unconfiguredGoogleClient } from './google/module.js';
export { remindersModule } from './reminders/module.js';
export * from './runtime-kit.js';
export { searchModule } from './search/module.js';
export { smsModule, unconfiguredTwilioClient } from './sms/module.js';
export { watchesModule } from './watches/module.js';

/**
 * Every module this build can install. Adding a capability means adding its
 * directory and one entry here — the HTTP app, executor, and UI are untouched.
 */
// biome-ignore lint/suspicious/noExplicitAny: a heterogeneous list of modules with differing export types
export const assistantModules: readonly ModuleDefinition<any>[] = [
  browserModule,
  codeModule,
  documentsModule,
  googleModule,
  remindersModule,
  searchModule,
  smsModule,
  watchesModule,
];

export interface InstalledModuleSet {
  /** Modules that were installed, in registration order. */
  enabled: readonly AssistantModule[];
  /**
   * What an installed module produced, or undefined when it is not installed
   * or produced nothing. Consumers that need a value regardless use the
   * module's own null-object factory.
   */
  exportsOf<Exports>(definition: ModuleDefinition<Exports>): Exports | undefined;
  /**
   * A completion summary when this code job belongs to a module that is not
   * installed, otherwise null. Jobs queued before a module was removed then
   * complete benignly instead of dead-lettering.
   */
  jobUnavailable(job: string): string | null;
}

/**
 * Install the modules this configuration selects. This is the sole
 * feature-composition point: a module registers its tools on the shared
 * registry — the only path into the risk-gated dispatcher — and returns
 * whatever the composition root needs to hold onto.
 */
export function installModules(
  definitions: readonly ModuleDefinition<unknown>[],
  context: ModulePlatformContext,
): InstalledModuleSet {
  const enabled: AssistantModule[] = [];
  const exports = new Map<ModuleDefinition<unknown>, unknown>();
  const jobOwners = new Map<string, AssistantModule>();

  for (const definition of definitions) {
    for (const job of definition.meta.jobs ?? []) jobOwners.set(job, definition.meta.name);
    if (!isModuleEnabled(context.config, definition.meta.name)) continue;
    enabled.push(definition.meta.name);
    const runtime = definition.create(context);
    if (runtime.exports !== undefined) exports.set(definition, runtime.exports);
  }

  const installed = new Set<AssistantModule>(enabled);
  return {
    enabled,
    exportsOf: <Exports>(definition: ModuleDefinition<Exports>) =>
      exports.get(definition as ModuleDefinition<unknown>) as Exports | undefined,
    jobUnavailable: (job) => {
      const owner = jobOwners.get(job);
      if (!owner || installed.has(owner)) return null;
      return `${job} skipped because the ${owner} module is disabled`;
    },
  };
}
