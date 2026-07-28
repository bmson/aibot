import type { Config } from '@assistant/config';
import { billingSummary, type DeploymentPlan } from '@assistant/modules/meta';
import { manualStepsFor } from './manual.js';
import type { CheckOutcome } from './preflight.js';

/**
 * Rendering for the setup briefing. Everything here is a pure string function so
 * the wording is testable without a project to point at.
 */
const MARKER: Record<CheckOutcome['status'], string> = { pass: '✓', warn: '!', fail: '✗' };

export function renderPreflight(outcomes: readonly CheckOutcome[]): string {
  const lines = ['Preflight:'];
  for (const outcome of outcomes) {
    lines.push(`  ${MARKER[outcome.status]} ${outcome.title}: ${outcome.detail}`);
  }
  const needsAction = outcomes.filter((outcome) => outcome.status !== 'pass' && outcome.guidance);
  if (needsAction.length > 0) {
    lines.push('');
    for (const outcome of needsAction) {
      lines.push(`${MARKER[outcome.status]} ${outcome.title}`);
      for (const line of (outcome.guidance ?? '').split('\n')) lines.push(`    ${line}`);
    }
  }
  return lines.join('\n');
}

export function renderComposition(plan: DeploymentPlan): string {
  const lines = ['Composition:'];
  lines.push(
    `  modules: ${plan.modules.length > 0 ? plan.modules.join(', ') : 'none (base only)'}`,
  );
  const workers = Object.entries(plan.workers)
    .filter(([, included]) => included)
    .map(([key]) => key);
  lines.push(`  worker images: ${workers.length > 0 ? workers.join(', ') : 'none'}`);
  if (plan.schedulerJobs.length > 0) {
    lines.push(`  scheduled jobs: ${plan.schedulerJobs.map((job) => job.name).join(', ')}`);
  }
  if (plan.gcpApis.length > 0) {
    lines.push(`  additional APIs: ${plan.gcpApis.length} enabled automatically`);
  }
  return lines.join('\n');
}

export function renderBilling(plan: DeploymentPlan): string {
  return [
    'What this costs:',
    ...billingSummary(plan)
      .split('\n')
      .map((line) => `  ${line}`),
  ].join('\n');
}

export function renderManualSteps(config: Config): string {
  const steps = manualStepsFor(config);
  if (steps.length === 0) return 'Manual steps: none for this installation.';
  const lines = ['Manual steps (these cannot be automated):'];
  for (const step of steps) {
    lines.push('');
    lines.push(`  ${step.done ? '✓' : '○'} ${step.title}`);
    lines.push(`     why: ${step.reason}`);
    if (step.done) {
      lines.push('     already satisfied by your current settings.');
      continue;
    }
    for (const instruction of step.instructions) lines.push(`     - ${instruction}`);
  }
  return lines.join('\n');
}

export interface WizardReport {
  outcomes: readonly CheckOutcome[];
  plan: DeploymentPlan;
  config: Config;
}

/** The full pre-provisioning briefing, in the order an operator needs it. */
export function renderReport(report: WizardReport): string {
  return [
    renderPreflight(report.outcomes),
    '',
    renderComposition(report.plan),
    '',
    renderBilling(report.plan),
    '',
    renderManualSteps(report.config),
  ].join('\n');
}
