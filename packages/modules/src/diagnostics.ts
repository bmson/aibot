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
 * Settings that are individually valid but leave the assistant unable to be
 * proactive — the failures that show up as silence rather than as an error.
 *
 * The one that matters: `EMAIL_INGEST_MODE` defaults to `direct`, which is for
 * people writing *to* the assistant. An owner who points a forwarding rule at
 * this mailbox and leaves the mode alone has their mail dropped as
 * unauthenticated (forwarding breaks SPF alignment) or as automated — the
 * flight confirmations, invoices and appointment reminders that carry every
 * date worth knowing. Nothing errors; `email_ingest` just stays empty, and with
 * it the importance alerts, the briefing's highlights, and the pulse's mail
 * moments. It is not a validation failure, because a genuinely direct mailbox
 * is a supported installation — so it is a note, not a problem.
 */
export function proactiveConfigNotes(config: Config = loadConfig()): string[] {
  const notes: string[] = [];
  if (isModuleEnabled(config, 'google') && config.EMAIL_INGEST_MODE !== 'forwarded') {
    notes.push(
      'EMAIL_INGEST_MODE is "direct": mail forwarded from your own inbox is dropped rather than ' +
        'scored, so the briefing and the pulse will have nothing to report. Set ' +
        'EMAIL_INGEST_MODE=forwarded if you forward your mail to this mailbox.',
    );
  }
  if (isModuleEnabled(config, 'google') && config.GMAIL_SYNC_ENABLED === 'false') {
    notes.push('GMAIL_SYNC_ENABLED is off: no mail is being read at all.');
  }
  if (!isModuleEnabled(config, 'push') && !isModuleEnabled(config, 'sms')) {
    notes.push(
      'Neither the push nor the sms module is installed, so proactive notices only appear when ' +
        'you open the dashboard.',
    );
  }
  return notes;
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
