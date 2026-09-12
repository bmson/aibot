import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  type InstallationResumeInput,
  persistInstallationManifest,
  resumePersistedInstallation,
  validateInstallationManifest,
  verifyInstallationArchive,
} from '@assistant/setup/installation';

const usage = `Usage:
  pnpm install:state --write --state PATH --manifest PATH --archive PATH [--expected PATH]
  pnpm install:state --resume --state PATH --input PATH

Writes only when --write is explicit. Archive verification hashes a local file;
it never extracts or executes it. Resume validates the persisted identity and
selection, but never advances a cloud stage or calls a provider.
`;

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`cannot read input file ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`input file ${path} is not valid JSON`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' },
      expected: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      input: { type: 'string' },
      manifest: { type: 'string' },
      resume: { type: 'boolean' },
      state: { type: 'string' },
      write: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const write = values.write === true;
  const resume = values.resume === true;
  if (write === resume) {
    throw new Error(`choose exactly one of --write or --resume\n\n${usage.trim()}`);
  }
  if (!values.state) throw new Error(`missing --state PATH\n\n${usage.trim()}`);

  if (write) {
    if (!values.manifest) throw new Error(`missing --manifest PATH\n\n${usage.trim()}`);
    if (!values.archive) throw new Error(`missing --archive PATH\n\n${usage.trim()}`);
    if (values.input || resume) throw new Error('--input and --resume are only valid with resume');
    const manifest = validateInstallationManifest(await readJson(values.manifest));
    if (manifest.stage.current !== 'previewed' || manifest.status !== 'active') {
      throw new Error('offline state may only persist an active previewed manifest');
    }
    await verifyInstallationArchive(values.archive, manifest.identity.release.archiveDigest);
    const expected = values.expected
      ? validateInstallationManifest(await readJson(values.expected))
      : null;
    await persistInstallationManifest(values.state, manifest, expected);
    process.stdout.write(`${JSON.stringify({ persisted: true, state: values.state })}\n`);
    return;
  }

  if (!values.input) throw new Error(`missing --input PATH\n\n${usage.trim()}`);
  if (values.manifest || values.archive || values.expected) {
    throw new Error('--manifest, --archive, and --expected are only valid with write');
  }
  const expected = (await readJson(values.input)) as InstallationResumeInput;
  const manifest = await resumePersistedInstallation(values.state, expected);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'installation state operation failed';
  process.stderr.write(`install:state: ${message}\n`);
  process.exitCode = 1;
}
