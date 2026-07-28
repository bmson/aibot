import {
  type AssistantModule,
  type Config,
  isModuleEnabled,
  loadConfig,
  validateProdConfig,
} from '@assistant/config';
import { assistantModuleMetas } from './registry.js';

export interface ModuleDiagnostic {
  module: AssistantModule;
  enabled: boolean;
  ready: boolean;
  detail: string;
}

/**
 * Secret-safe diagnostics for setup tooling and the readiness probe. This
 * reports only presence and absence, never a configured value.
 */
export function moduleDiagnostics(config: Config = loadConfig()): ModuleDiagnostic[] {
  return assistantModuleMetas.map((meta) => {
    if (!isModuleEnabled(config, meta.name)) {
      return { module: meta.name, enabled: false, ready: false, detail: 'disabled' };
    }
    // A module with no settings that can be missing is ready by definition.
    const { ready, detail } = meta.readiness?.(config) ?? { ready: true, detail: 'ready' };
    return { module: meta.name, enabled: true, ready, detail };
  });
}

/**
 * Module-specific production problems, including settings that require a module
 * the installation has disabled — so these are evaluated for every module, not
 * just the enabled ones. Only cloud-shaped installations are validated, matching
 * `validateProdConfig`: a local or intentionally minimal install may run
 * degraded.
 */
export function moduleProdProblems(config: Config = loadConfig()): string[] {
  if (config.QUEUE_DRIVER !== 'cloudtasks') return [];
  return assistantModuleMetas.flatMap((meta) => meta.prodProblems?.(config) ?? []);
}

/** Platform configuration problems plus every module's own. */
export function validateAssistantConfig(config: Config = loadConfig()): string[] {
  return [...validateProdConfig(config), ...moduleProdProblems(config)];
}

/**
 * Routes belonging to modules this installation does not have. The web shell
 * filters its navigation with this, so a module with UI declares its routes once
 * in metadata instead of the layout naming them.
 */
export function hiddenModuleNavHrefs(config: Config = loadConfig()): Set<string> {
  const hidden = new Set<string>();
  for (const meta of assistantModuleMetas) {
    if (isModuleEnabled(config, meta.name)) continue;
    for (const href of meta.ui?.navHrefs ?? []) hidden.add(href);
  }
  return hidden;
}
