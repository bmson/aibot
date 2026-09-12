import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  type ConsumerInstallOptions,
  provisionConsumerInstallation,
  systemRunner,
  validateInstallationManifest,
} from '@assistant/setup/installation';

const usage = `Usage: pnpm consumer:install --manifest PATH --archive PATH --state PATH --state-bucket NAME --terraform-dir PATH [--apply]

Without --apply this verifies the release archive, customer project, and selected Firestore database absence.
With --apply it bootstraps customer-owned state, runs Terraform, and records resumable foundation stages.
`;

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`cannot read valid JSON from ${path}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' },
      apply: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      manifest: { type: 'string' },
      state: { type: 'string' },
      'state-bucket': { type: 'string' },
      'terraform-dir': { type: 'string' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const required = [
    ['--manifest', values.manifest],
    ['--archive', values.archive],
    ['--state', values.state],
    ['--state-bucket', values['state-bucket']],
    ['--terraform-dir', values['terraform-dir']],
  ] as const;
  const missing = required.find(([, value]) => !value)?.[0];
  if (missing) throw new Error(`missing ${missing}\n\n${usage.trim()}`);
  const options: ConsumerInstallOptions = {
    manifest: validateInstallationManifest(await json(values.manifest as string)),
    archivePath: values.archive as string,
    statePath: values.state as string,
    stateBucket: values['state-bucket'] as string,
    terraformDir: values['terraform-dir'] as string,
    apply: values.apply === true,
  };
  const result = await provisionConsumerInstallation({ runner: systemRunner }, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `consumer:install: ${error instanceof Error ? error.message : 'installation failed'}\n`,
  );
  process.exitCode = 1;
}
