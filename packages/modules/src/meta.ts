import {
  type AssistantModule,
  assistantModuleNames,
  type Config,
  isModuleEnabled,
  loadConfig,
  validateProdConfig,
} from '@assistant/config';
import { browserMeta } from './browser/meta.js';
import { codeMeta } from './code/meta.js';
import { documentsMeta } from './documents/meta.js';
import { googleMeta } from './google/meta.js';
import type { ModuleMeta } from './kit.js';
import { remindersMeta } from './reminders/meta.js';
import { searchMeta } from './search/meta.js';
import { smsMeta } from './sms/meta.js';
import { watchesMeta } from './watches/meta.js';

export * from './kit.js';

/**
 * Every module's metadata, ordered like `assistantModuleNames` so diagnostics
 * and deployment plans read in a stable order. A conformance test asserts this
 * list stays exactly in step with the configuration enum.
 */
export const assistantModuleMetas: readonly ModuleMeta[] = [
  browserMeta,
  codeMeta,
  documentsMeta,
  googleMeta,
  remindersMeta,
  searchMeta,
  smsMeta,
  watchesMeta,
];

const metaByName = new Map<AssistantModule, ModuleMeta>(
  assistantModuleMetas.map((meta) => [meta.name, meta]),
);

export function moduleMeta(name: AssistantModule): ModuleMeta {
  const meta = metaByName.get(name);
  if (!meta) throw new Error(`no metadata registered for module: ${name}`);
  return meta;
}

export interface ModuleDiagnostic {
  module: AssistantModule;
  enabled: boolean;
  ready: boolean;
  detail: string;
}

/**
 * Secret-safe diagnostics for setup tooling and the readiness probe. This
 * reports only presence/absence and never includes a configured value.
 */
export function moduleDiagnostics(config: Config = loadConfig()): ModuleDiagnostic[] {
  return assistantModuleNames.map((module) => {
    if (!isModuleEnabled(config, module)) {
      return { module, enabled: false, ready: false, detail: 'disabled' };
    }
    const readiness = moduleMeta(module).readiness?.(config) ?? { ready: true, detail: 'ready' };
    return { module, enabled: true, ready: readiness.ready, detail: readiness.detail };
  });
}

/**
 * Module-specific production problems, including settings that require a module
 * the installation has disabled. Only cloud-shaped installations are validated,
 * matching `validateProdConfig`: a local or intentionally minimal install may
 * run degraded.
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
 * Navigation belonging to modules this installation has disabled. The web shell
 * filters its nav with this, so a module with UI declares its entry once in
 * metadata instead of editing the layout.
 */
export function hiddenModuleNavHrefs(config: Config = loadConfig()): Set<string> {
  const hidden = new Set<string>();
  for (const meta of assistantModuleMetas) {
    if (isModuleEnabled(config, meta.name)) continue;
    for (const item of meta.ui?.nav ?? []) hidden.add(item.href);
  }
  return hidden;
}
