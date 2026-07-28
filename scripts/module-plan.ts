import { appendFileSync } from 'node:fs';
import { loadConfig } from '@assistant/config';
import { billingSummary, deploymentPlan } from '@assistant/modules/meta';
import composition from '../assistant.config.js';

/**
 * The one place deployment learns what an installation contains. CI selects
 * worker images from it, the provisioner sources it instead of re-parsing
 * ASSISTANT_MODULES in bash, and `--billing` explains what enabling these
 * modules costs.
 *
 * The plan describes the composition file narrowed by ASSISTANT_MODULES, which
 * is exactly what the built image will run.
 */
const config = loadConfig();
const plan = deploymentPlan(
  config,
  composition.modules.map((definition) => definition.meta),
);
const workerKeys = Object.keys(plan.workers).sort();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const format = process.argv.find((argument) => argument.startsWith('--format='))?.slice(9);
const githubOutput = process.argv.find((argument) => argument.startsWith('--github-output='));

if (process.argv.includes('--billing')) {
  process.stdout.write(`${billingSummary(plan)}\n`);
} else if (githubOutput) {
  // Keys consumed by .github/workflows/deploy.yml; each worker key is always
  // present so a disabled module yields an explicit false.
  appendFileSync(
    githubOutput.slice('--github-output='.length),
    [
      `modules=${plan.modules.join(',')}`,
      ...workerKeys.map((key) => `${key}=${String(plan.workers[key])}`),
      '',
    ].join('\n'),
  );
} else if (format === 'env') {
  const lines = [
    `PLAN_MODULES=${shellQuote(plan.modules.join(','))}`,
    `PLAN_GCP_APIS=${shellQuote(plan.gcpApis.join(' '))}`,
    `PLAN_PUBSUB_TOPICS=${shellQuote(plan.pubsubTopics.join(' '))}`,
    ...workerKeys.map(
      (key) => `PLAN_WORKER_${key.toUpperCase()}=${shellQuote(String(plan.workers[key]))}`,
    ),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
} else {
  // Worker booleans stay at the top level for compatibility with readers that
  // predate the richer plan.
  process.stdout.write(`${JSON.stringify({ ...plan.workers, ...plan }, null, 2)}\n`);
}
