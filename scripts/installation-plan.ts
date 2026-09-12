import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { previewInstallation } from '@assistant/setup/installation-plan';

const usage = `Usage: pnpm install:plan --input PATH

Reads a local JSON CreateInstallationManifestInput and prints a deterministic,
preview-only installation plan. It never calls gcloud, loads runtime config,
provisions resources, or writes files.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      input: { type: 'string' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const inputPath = values.input;
  if (!inputPath) throw new Error(`missing --input PATH\n\n${usage.trim()}`);
  let raw: string;
  try {
    raw = await readFile(inputPath, 'utf8');
  } catch {
    throw new Error(`cannot read input file ${inputPath}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error(`input file ${inputPath} is not valid JSON`);
  }
  const preview = previewInstallation(input as Parameters<typeof previewInstallation>[0]);
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'installation preview failed';
  process.stderr.write(`install:plan: ${message}\n`);
  process.exitCode = 1;
}
