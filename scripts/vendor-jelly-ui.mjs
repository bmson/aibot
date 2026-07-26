import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceCommit = 'd898ec995f3cbe16e720c4857c13c0dceb489585';
const sourceVersion = '1.0.0';
const vendorVersion = sourceCommit.slice(0, 7);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.JELLY_UI_DIR ?? join(repositoryRoot, '..', 'ui'));
const vendorRoot = join(
  repositoryRoot,
  'apps',
  'web',
  'public',
  'vendor',
  'jelly-ui',
  vendorVersion,
);
const metadataPath = join(vendorRoot, 'source.json');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function checkVendor() {
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const bundlePath = join(vendorRoot, 'jelly.js');
  if (metadata.sourceCommit !== sourceCommit) {
    throw new Error(
      `Jelly source mismatch: expected ${sourceCommit}, found ${metadata.sourceCommit}`,
    );
  }
  const actualHash = sha256(bundlePath);
  if (metadata.bundleSha256 !== actualHash) {
    throw new Error(
      `Jelly bundle checksum mismatch: expected ${metadata.bundleSha256}, found ${actualHash}`,
    );
  }
  console.log(`Jelly UI ${vendorVersion} verified (${actualHash.slice(0, 12)}).`);
}

if (process.argv.includes('--check')) {
  checkVendor();
  process.exit(0);
}

if (!existsSync(join(sourceRoot, '.git'))) {
  throw new Error(
    `Jelly UI checkout not found at ${sourceRoot}. Set JELLY_UI_DIR to the repository path.`,
  );
}

const buildRoot = mkdtempSync(join(tmpdir(), 'assistant-jelly-ui-'));
try {
  const archive = execFileSync('git', ['-C', sourceRoot, 'archive', sourceCommit]);
  execFileSync('tar', ['-x', '-C', buildRoot], {
    input: archive,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  const pinnedLockfile = join(vendorRoot, 'build-pnpm-lock.yaml');
  if (existsSync(pinnedLockfile)) {
    copyFileSync(pinnedLockfile, join(buildRoot, 'pnpm-lock.yaml'));
    execFileSync('corepack', ['pnpm', '--dir', buildRoot, 'install', '--frozen-lockfile'], {
      stdio: 'inherit',
    });
  } else {
    execFileSync('corepack', ['pnpm', '--dir', buildRoot, 'install', '--no-frozen-lockfile'], {
      stdio: 'inherit',
    });
  }
  execFileSync('corepack', ['pnpm', '--dir', buildRoot, 'build'], { stdio: 'inherit' });

  mkdirSync(vendorRoot, { recursive: true });
  for (const file of ['jelly.js', 'jelly.js.map']) {
    copyFileSync(join(buildRoot, 'dist', file), join(vendorRoot, file));
  }
  // The declaration generator emits CRLF regardless of the host platform.
  // Normalize the vendored text artifact so repository checks stay stable.
  writeFileSync(
    join(vendorRoot, 'jelly.d.ts'),
    readFileSync(join(buildRoot, 'dist', 'jelly.d.ts'), 'utf8').replace(/\r\n/g, '\n'),
  );
  copyFileSync(join(buildRoot, 'LICENSE'), join(vendorRoot, 'LICENSE'));
  copyFileSync(join(buildRoot, 'pnpm-lock.yaml'), join(vendorRoot, 'build-pnpm-lock.yaml'));

  const bundleSha256 = sha256(join(vendorRoot, 'jelly.js'));
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        name: 'jelly-ui',
        version: sourceVersion,
        sourceRepository: 'https://github.com/jelly-org/ui.git',
        sourceCommit,
        bundleSha256,
      },
      null,
      2,
    )}\n`,
  );
  checkVendor();
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}
