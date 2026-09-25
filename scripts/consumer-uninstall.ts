import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type CommandRunner,
  planConsumerUninstall,
  readPersistedInstallation,
  runConsumerUninstall,
  systemRunner,
} from '@assistant/setup/installation';

const usage = `Usage: pnpm consumer:uninstall --state PATH --state-bucket NAME [--delete-data --confirm-installation ID [--delete-state]] [--apply]

Removes a customer-owned installation using only its recorded inventory and
installer naming. Without --apply it prints the ordered plan and what stays billable.

Default: stop the sweep job and queue, delete both Cloud Run services, runtime
service accounts and their project grants, and installer-generated secrets. The
Firestore database, buckets, image repository, and state bucket are kept.
--delete-data additionally deletes the image repository, the Firestore database
(after disabling delete protection), and the assets/source buckets. It requires
--confirm-installation with the exact installation ID. Export first if you need
the data (scripts/firestore-managed-backup.ts --backup; see docs/consumer-fresh-account-pilot.md).
--delete-state finally deletes the Terraform state and release receipts.
Rerunning resumes; resources that are already gone count as done. The project
itself, enabled APIs, and customer-created secrets are never deleted.
`;

export async function runConsumerUninstallCli(
  argv: string[] = process.argv.slice(2),
  runner: CommandRunner = systemRunner,
): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      state: { type: 'string' },
      'state-bucket': { type: 'string' },
      'delete-data': { type: 'boolean', default: false },
      'delete-state': { type: 'boolean', default: false },
      'confirm-installation': { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return usage;
  if (!values.state || !values['state-bucket'])
    throw new Error(`missing --state or --state-bucket\n\n${usage.trim()}`);
  const manifest = await readPersistedInstallation(values.state);
  if (!manifest) throw new Error('No persisted installation state at --state');
  if (values['delete-data'] && values['confirm-installation'] !== manifest.identity.installationId)
    throw new Error(
      `--delete-data requires --confirm-installation ${manifest.identity.installationId}`,
    );
  const plan = planConsumerUninstall(manifest, {
    stateBucket: values['state-bucket'],
    deleteData: values['delete-data'] === true,
    deleteState: values['delete-state'] === true,
  });
  const execution = await runConsumerUninstall(runner, plan, values.apply === true);
  return {
    applied: values.apply === true,
    completed: execution.completed,
    installationId: plan.installationId,
    projectId: plan.projectId,
    steps: plan.steps.map((step, index) => ({
      id: step.id,
      description: step.description,
      destroysData: step.destroysData,
      status: execution.steps[index]?.status,
      command: `gcloud ${step.args.join(' ')}`,
    })),
    retained: plan.retained,
    note: values.apply
      ? execution.completed
        ? 'Uninstall steps finished. Review the retained resources for remaining charges.'
        : 'A step failed; fix access or the reported resource and rerun the same command.'
      : 'Preview only. Rerun with --apply to execute these steps in order.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsumerUninstallCli()
    .then((result) => {
      process.stdout.write(
        typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`,
      );
      if (
        result &&
        typeof result === 'object' &&
        (result as { applied?: boolean; completed?: boolean }).applied &&
        !(result as { completed?: boolean }).completed
      )
        process.exitCode = 2;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `consumer:uninstall: ${error instanceof Error ? error.message : 'uninstall failed'}\n`,
      );
      process.exitCode = 1;
    });
}
