import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createInstallationStore,
  FirestoreOwnerAuthRepository,
  generateOwnerSecret,
  OWNER_CLAIM_TTL_MS,
  OwnerAuthRejectedError,
  ownerSecretVerifier,
} from '@assistant/firestore';
import { createGcloudAuthClient } from './gcloud-auth.js';

const usage = `Usage: pnpm consumer:owner-claim --project PROJECT --installation ID --database DATABASE --url HTTPS_ORIGIN [--recover] [--gcloud-auth] [--apply]

Issues a single-use, 24-hour passkey setup link for a customer-owned installation
running OWNER_AUTH_MODE=passkey. Only the claim verifier is written to Firestore;
the link is printed once on stdout and never stored.

Without --apply this reads the claim state and changes nothing.
--recover issues a cloud-owner recovery link for an already-claimed installation
(it signs out every existing session when used). A first claim refuses a claimed
installation, and a recovery claim refuses an unclaimed one.
--gcloud-auth uses the active gcloud CLI account in memory; ADC remains the default.
`;

type Dependencies = {
  createAuthClient?: typeof createGcloudAuthClient;
  createStore?: typeof createInstallationStore;
  now?: () => Date;
  secret?: () => string;
};

export type OwnerClaimResult =
  | { applied: false; claimed: boolean; grant: 'claim' | 'recovery' }
  | {
      applied: true;
      grant: 'claim' | 'recovery';
      expiresAt: string;
      setupUrl: string;
    };

function origin(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error('--url must be the exact HTTPS origin configured as AUTH_URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username
  )
    throw new Error('--url must be the exact HTTPS origin configured as AUTH_URL');
  return url.origin;
}

export async function runConsumerOwnerClaimCli(
  argv: string[] = process.argv.slice(2),
  dependencies: Dependencies = {},
): Promise<OwnerClaimResult | string> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      installation: { type: 'string' },
      database: { type: 'string' },
      url: { type: 'string' },
      recover: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'gcloud-auth': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return usage;
  if (!values.project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values.project))
    throw new Error('--project must name the customer Google Cloud project');
  if (!values.installation || !/^[a-z][a-z0-9-]{2,20}$/.test(values.installation))
    throw new Error('--installation must name the installation ID');
  if (!values.database || !/^\(default\)$|^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(values.database))
    throw new Error('--database must explicitly select a valid Firestore database ID');
  const base = origin(values.url);
  const grant = values.recover ? 'recovery' : 'claim';
  const authClient = values['gcloud-auth']
    ? await (dependencies.createAuthClient ?? createGcloudAuthClient)()
    : undefined;
  const store = (dependencies.createStore ?? createInstallationStore)({
    projectId: values.project,
    installationId: values.installation,
    databaseId: values.database,
    ...(authClient ? { authClient } : {}),
  });
  try {
    const repository = new FirestoreOwnerAuthRepository(store);
    if (!values.apply) {
      const state = await repository.state();
      return { applied: false, claimed: state.claimed, grant };
    }
    const now = (dependencies.now ?? (() => new Date()))();
    const expiresAt = new Date(now.getTime() + OWNER_CLAIM_TTL_MS);
    const code = (dependencies.secret ?? generateOwnerSecret)();
    try {
      await repository.issueClaim({
        verifier: ownerSecretVerifier('claim', code),
        grant,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof OwnerAuthRejectedError && error.code === 'already_claimed')
        throw new Error(
          'This installation already has an owner. Use --recover to issue a cloud-owner recovery link.',
        );
      if (error instanceof OwnerAuthRejectedError && error.code === 'not_claimed')
        throw new Error(
          'This installation has no owner yet. Issue a first claim without --recover.',
        );
      throw error;
    }
    return {
      applied: true,
      grant,
      expiresAt: expiresAt.toISOString(),
      setupUrl: `${base}/setup#claim=${code}`,
    };
  } finally {
    await store.db.terminate();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConsumerOwnerClaimCli()
    .then((result) =>
      process.stdout.write(
        typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `consumer:owner-claim: ${error instanceof Error ? error.message : 'claim failed'}\n`,
      );
      process.exitCode = 1;
    });
}
