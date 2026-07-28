import type { AssistantModule } from '@assistant/config';
import type { ModuleDefinition } from './runtime-kit.js';

export interface AssistantComposition {
  /**
   * The modules this build contains. Anything absent has no definition to
   * install, so it cannot be switched on later by configuration alone.
   */
  // biome-ignore lint/suspicious/noExplicitAny: a heterogeneous list of modules with differing export types
  modules: readonly ModuleDefinition<any>[];
}

/**
 * Declare what this installation is made of.
 *
 * Composition is static on purpose. Because the set of modules is known before
 * the image is built, the deployment plan knows which worker images to build
 * and which resources to provision, and the billing explanation describes the
 * installation that will actually run. `ASSISTANT_MODULES` then selects among
 * what was composed — it restricts this list and can never extend it.
 *
 * Excluded modules are not yet stripped from the bundle: `apps/agent` still
 * imports the `@assistant/tools` root barrel, which pulls every provider in
 * regardless. Removing that import is what would make composition shrink the
 * image as well as the installation.
 */
export function defineAssistant(composition: AssistantComposition): AssistantComposition {
  return composition;
}

/** The modules a composition contains, in declaration order. */
export function composedModuleNames(composition: AssistantComposition): readonly AssistantModule[] {
  return composition.modules.map((definition) => definition.meta.name);
}
