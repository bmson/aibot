import { randomUUID } from 'node:crypto';
import {
  FirestoreOwnerAuthRepository,
  InstallationStore,
  ownerSecretVerifier,
} from '@assistant/firestore';
import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { runConsumerOwnerClaimCli } from './consumer-owner-claim.js';

const base = [
  '--project',
  'customer-project',
  '--installation',
  'pilot',
  '--database',
  'assistant-pilot',
  '--url',
  'https://pilot-web-123.us-west1.run.app',
];

describe('consumer owner claim CLI validation', () => {
  it('rejects non-origin URLs and invalid identifiers before any Google client', async () => {
    const createStore = () => {
      throw new Error('must not connect');
    };
    await expect(
      runConsumerOwnerClaimCli([...base.slice(0, -1), 'https://pilot.example.com/setup'], {
        createStore,
      }),
    ).rejects.toThrow('exact HTTPS origin');
    await expect(
      runConsumerOwnerClaimCli([...base.slice(0, -1), 'http://pilot.example.com'], {
        createStore,
      }),
    ).rejects.toThrow('exact HTTPS origin');
    await expect(
      runConsumerOwnerClaimCli(['--project', 'X', ...base.slice(2)], { createStore }),
    ).rejects.toThrow('--project');
    expect(await runConsumerOwnerClaimCli(['--help'])).toContain('consumer:owner-claim');
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('consumer owner claim CLI', () => {
  it('previews, issues a verifier-only claim once, and refuses a second first claim', async () => {
    const installationId = `test-${randomUUID()}`;
    const createStore = () =>
      new InstallationStore(
        new Firestore({ projectId: 'demo-assistant-test', databaseId: '(default)' }),
        installationId,
      );
    const inspect = createStore();
    // The repository checks expiry against the real clock, so issue relative to it.
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    try {
      const preview = await runConsumerOwnerClaimCli(base, { createStore });
      expect(preview).toEqual({ applied: false, claimed: false, grant: 'claim' });
      const code = 'C'.repeat(43);
      const issued = await runConsumerOwnerClaimCli([...base, '--apply'], {
        createStore,
        secret: () => code,
        now: () => issuedAt,
      });
      expect(issued).toEqual({
        applied: true,
        grant: 'claim',
        expiresAt: new Date(issuedAt.getTime() + 24 * 3600_000).toISOString(),
        setupUrl: `https://pilot-web-123.us-west1.run.app/setup#claim=${code}`,
      });
      const stored = (await inspect.doc('ownerAuth', 'claim').get()).data();
      expect(JSON.stringify(stored)).not.toContain(code);
      expect(stored?.verifier).toBe(ownerSecretVerifier('claim', code));
      await expect(
        runConsumerOwnerClaimCli([...base, '--recover', '--apply'], { createStore }),
      ).rejects.toThrow('no owner yet');
      // Simulate a completed claim, then only a recovery link is allowed.
      await inspect.doc('ownerAuth', 'state').set({ claimedAt: new Date(), sessionGeneration: 1 });
      await expect(runConsumerOwnerClaimCli([...base, '--apply'], { createStore })).rejects.toThrow(
        'already has an owner',
      );
      const recovery = await runConsumerOwnerClaimCli([...base, '--recover', '--apply'], {
        createStore,
      });
      expect(recovery).toMatchObject({ applied: true, grant: 'recovery' });
      expect(await new FirestoreOwnerAuthRepository(inspect).state()).toMatchObject({
        claimed: true,
      });
    } finally {
      await inspect.db.recursiveDelete(inspect.root);
      await inspect.db.terminate();
    }
  });
});
