import { appendFileSync } from 'node:fs';
import { loadConfig } from '@assistant/config';
import { composedModuleMetas } from '@assistant/modules';
import { billingSummary, deploymentPlan } from '@assistant/modules/meta';
import composition from '../assistant.config.js';

/**
 * The one place deployment learns what an installation contains.
 *
 * The plan is the composition file narrowed by ASSISTANT_MODULES, which is
 * exactly what the built image will run. CI selects worker images from it, the
 * provisioner sources it rather than re-parsing ASSISTANT_MODULES in bash, and
 * `--billing` explains what enabling these modules costs.
 *
 *   pnpm modules:plan                      pretty JSON, for reading
 *   pnpm modules:plan --billing            what this installation costs
 *   pnpm modules:plan --format=env         shell assignments for deploy.sh
 *   pnpm modules:plan --github-output=FILE step outputs for the deploy workflow
 */
const plan = deploymentPlan(loadConfig(), composedModuleMetas(composition));
const workerImages = Object.keys(plan.workers).sort();

/** Wrap a value so the shell reads it as one literal, whatever it contains. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const githubOutput = process.argv
  .find((argument) => argument.startsWith('--github-output='))
  ?.slice('--github-output='.length);
const format = process.argv.find((argument) => argument.startsWith('--format='))?.slice(9);

if (process.argv.includes('--billing')) {
  process.stdout.write(`${billingSummary(plan)}\n`);
} else if (githubOutput) {
  // Every worker image is emitted, so a module this installation excludes gives
  // the workflow an explicit false instead of an empty string.
  appendFileSync(
    githubOutput,
    [
      `modules=${plan.modules.join(',')}`,
      ...workerImages.map((image) => `${image}=${String(plan.workers[image])}`),
      '',
    ].join('\n'),
  );
} else if (format === 'env') {
  // One newline-separated `name|schedule|path` record per job. Newlines rather
  // than spaces because cron expressions contain both spaces and `*`, so a
  // space-separated list would word-split and then glob against the filesystem.
  const schedulerJobs = plan.schedulerJobs.map((job) => `${job.name}|${job.schedule}|${job.path}`);
  process.stdout.write(
    `${[
      `PLAN_MODULES=${shellQuote(plan.modules.join(','))}`,
      `PLAN_GCP_APIS=${shellQuote(plan.gcpApis.join(' '))}`,
      `PLAN_SCHEDULER_JOBS=${shellQuote(schedulerJobs.join('\n'))}`,
    ].join('\n')}\n`,
  );
} else {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
