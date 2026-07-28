import { type AssistantModule, isModuleEnabled } from '@assistant/config';
import type { ModuleDefinition, ModulePlatformContext } from './platform.js';

export interface InstalledModuleSet {
  /** Modules that were installed, in composition order. */
  installed: readonly AssistantModule[];
  /**
   * What an installed module produced, or undefined when it is absent or
   * produced nothing.
   */
  exportsOf<Exports>(definition: ModuleDefinition<Exports>): Exports | undefined;
  /**
   * Like `exportsOf`, but for modules declaring an `absent` null object, so the
   * caller always gets a value. Throws when a module declares neither — that is
   * a composition mistake, and failing at boot beats an undefined field
   * surfacing somewhere later.
   */
  requireExports<Exports>(definition: ModuleDefinition<Exports>): Exports;
  /**
   * A completion summary when this code job belongs to a module that is not
   * installed, otherwise null. Jobs queued before a module was removed then
   * complete benignly instead of dead-lettering.
   */
  jobUnavailable(job: string): string | null;
}

/**
 * Install the modules this installation composes and configures.
 *
 * This is the sole feature-composition point: a module registers its tools on
 * the shared registry — the only path into the risk-gated dispatcher — and
 * returns whatever the composition root needs to hold onto.
 */
export function installModules(
  definitions: readonly ModuleDefinition<unknown>[],
  context: ModulePlatformContext,
): InstalledModuleSet {
  const installed: AssistantModule[] = [];
  const exports = new Map<ModuleDefinition<unknown>, unknown>();
  const jobOwners = new Map<string, AssistantModule>();

  for (const definition of definitions) {
    // Job ownership is recorded for every composed module, installed or not, so
    // a job belonging to a disabled one is still recognised rather than failing.
    for (const job of definition.meta.jobs ?? []) jobOwners.set(job, definition.meta.name);
    if (!isModuleEnabled(context.config, definition.meta.name)) continue;
    installed.push(definition.meta.name);
    const runtime = definition.create(context);
    if (runtime.exports !== undefined) exports.set(definition, runtime.exports);
  }

  // Configuration selects among what the build composes; it cannot add to it.
  // Saying so beats a module that silently never starts.
  const composed = new Set(definitions.map((definition) => definition.meta.name));
  for (const name of context.config.ASSISTANT_MODULES) {
    if (composed.has(name)) continue;
    console.warn(
      `ASSISTANT_MODULES names "${name}", which this build does not contain — add it to assistant.config.ts and rebuild`,
    );
  }

  const exportsOf = <Exports>(definition: ModuleDefinition<Exports>) =>
    exports.get(definition as ModuleDefinition<unknown>) as Exports | undefined;

  return {
    installed,
    exportsOf,
    requireExports: (definition) => {
      const produced = exportsOf(definition);
      if (produced !== undefined) return produced;
      const absent = definition.absent?.();
      if (absent !== undefined) return absent;
      throw new Error(
        `the ${definition.meta.name} module produced no exports and declares no absent value`,
      );
    },
    jobUnavailable: (job) => {
      const owner = jobOwners.get(job);
      if (!owner || installed.includes(owner)) return null;
      return `${job} skipped because the ${owner} module is disabled`;
    },
  };
}
