import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '@assistant/config';
import { deploymentPlan } from '@assistant/modules/meta';
import { canProceed, renderReport, runPreflight, systemRunner } from '@assistant/setup';
import composition from '../assistant.config.js';

/**
 * Guided setup: check what would stop a deploy, explain what this installation
 * contains and what it costs, then hand over to the idempotent provisioner.
 *
 * `--plan` stops after the briefing so everything can be inspected without
 * touching the project.
 */
const planOnly = process.argv.includes('--plan');
const assumeYes = process.argv.includes('--yes');

const config = loadConfig();
const plan = deploymentPlan(
  config,
  composition.modules.map((definition) => definition.meta),
);

const project =
  config.GCP_PROJECT ||
  (await systemRunner.run('gcloud', ['config', 'get-value', 'project'])).stdout.trim();

const outcomes = await runPreflight({ config, runner: systemRunner, project });
console.log(renderReport({ outcomes, plan, config }));
console.log('');

const ready = canProceed(outcomes);

if (planOnly) {
  console.log(
    ready
      ? 'Plan only — nothing was changed. Re-run without --plan to provision.'
      : 'Plan only — nothing was changed. Resolve the failing checks above before provisioning.',
  );
  process.exit(0);
}

if (!ready) {
  console.error('Setup cannot continue until the failing checks above are resolved.');
  process.exit(1);
}

if (!assumeYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Provision this into ${project}? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Nothing was changed.');
    process.exit(0);
  }
}

// The provisioner is already idempotent and reads the same module plan, so the
// wizard runs it rather than reimplementing provisioning.
const deploy = spawn('bash', ['infra/gcp/deploy.sh'], { stdio: 'inherit' });
deploy.on('exit', (code) => process.exit(code ?? 1));
