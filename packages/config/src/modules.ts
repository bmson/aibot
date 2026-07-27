import { z } from 'zod';

/**
 * Optional capabilities installed by the agent composition root.
 *
 * The base assistant (chat, memory, goals, workspace, approvals, and missions)
 * is always present. Keeping it out of this list prevents a configuration from
 * accidentally disabling the runtime required to boot and manage the system.
 */
export const assistantModuleNames = [
  'browser',
  'code',
  'documents',
  'google',
  'reminders',
  'search',
  'sms',
  'watches',
] as const;

export type AssistantModule = (typeof assistantModuleNames)[number];

const AssistantModuleSchema = z.enum(assistantModuleNames);

export const allAssistantModules: readonly AssistantModule[] = assistantModuleNames;

/**
 * Parse the human-friendly comma-separated environment value.
 *
 * - `all` (and an omitted value) preserves the full historical installation.
 * - `minimal` or an empty value starts only the base assistant.
 * - A comma-separated list enables exactly those optional capabilities.
 */
export function parseAssistantModules(value: string | undefined): AssistantModule[] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === 'all') return [...allAssistantModules];
  if (normalized === '' || normalized === 'minimal') return [];

  const tokens = normalized
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.includes('all') || tokens.includes('minimal')) {
    throw new Error('ASSISTANT_MODULES aliases cannot be combined with module names');
  }

  return [...new Set(tokens.map((token) => AssistantModuleSchema.parse(token)))];
}

export function isModuleEnabled(
  config: { ASSISTANT_MODULES: readonly AssistantModule[] },
  module: AssistantModule,
): boolean {
  return config.ASSISTANT_MODULES.includes(module);
}
