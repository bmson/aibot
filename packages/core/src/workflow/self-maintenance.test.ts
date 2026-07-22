// Set before any loadConfig() call in this isolated test file so the PR-primitive
// token gate is satisfied for the gating tests.
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_REPO = 'bmson/aibot';

import { createDb, type Db, improvementProposals, selfMaintenance } from '@assistant/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import {
  isProtectedPath,
  openSelfMaintenancePR,
  partitionChangedFiles,
  runSelfMaintenance,
} from './self-maintenance.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('self-maintenance fence (the load-bearing guardrail)', () => {
  it('blocks infra, migrations, and autonomy/trust/security paths', () => {
    for (const p of [
      'infra/gcp/deploy.sh',
      'infra/docker/agent.Dockerfile',
      '.github/workflows/deploy.yml',
      'packages/db/drizzle/0001_init.sql',
      'packages/db/src/schema.ts',
      'packages/db/src/seed.ts',
      'packages/tools/src/dispatcher.ts',
      'packages/tools/src/registry.ts',
      'packages/tools/src/policies.ts',
      'packages/core/src/workflow/approvals.ts',
      'packages/core/src/workflow/anomaly.ts',
      'packages/core/src/events.ts',
      'packages/core/src/workflow/executor.ts',
      'packages/core/src/workflow/executor/step-loop.ts',
      'packages/core/src/workflow/self-maintenance.ts',
      'packages/core/src/workflow/improve.ts',
      'packages/core/src/workflow/dream.ts',
      'packages/core/src/config.ts',
      'scripts/auth-bot.ts',
      'apps/agent/src/google-oidc.ts',
      'apps/agent/src/routes/webhooks.ts',
      'packages/core/src/email-provenance.ts',
      'apps/web/auth.ts',
      'some/path/credentials.ts',
      'x/secret-store.ts',
      '.env.example',
      // fail-closed on junk
      '',
      '/etc/passwd',
      '../escape.ts',
    ]) {
      expect(isProtectedPath(p), `${p} must be protected`).toBe(true);
    }
  });

  it('allows ordinary, non-security code', () => {
    for (const p of [
      'packages/core/src/browse.ts',
      'packages/tools/src/google/gmail.ts',
      'packages/core/src/memory/occasions.ts',
      'apps/web/app/documents/page.tsx',
      'workers/browser-job/src/steps.ts',
    ]) {
      expect(isProtectedPath(p), `${p} should be allowed`).toBe(false);
    }
  });

  it('partitions a changed-file set into allowed vs blocked', () => {
    const { allowed, blocked } = partitionChangedFiles([
      'packages/core/src/browse.ts',
      'packages/tools/src/dispatcher.ts',
      'apps/web/app/documents/page.tsx',
      'infra/gcp/deploy.sh',
    ]);
    expect(allowed).toEqual(['packages/core/src/browse.ts', 'apps/web/app/documents/page.tsx']);
    expect(blocked).toEqual(['packages/tools/src/dispatcher.ts', 'infra/gcp/deploy.sh']);
  });
});

describe('self-maintenance PR primitive (fenced + gated)', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  async function cleanup() {
    await db.delete(selfMaintenance).where(like(selfMaintenance.title, 'XTESTMAINT%'));
    await db.delete(improvementProposals).where(like(improvementProposals.title, 'xtest-maint%'));
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('self-maintenance.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  async function makeItem(title: string) {
    const [row] = await db
      .insert(selfMaintenance)
      .values({ agentId, title, targetArea: 'packages/core/src/browse.ts', status: 'backlog' })
      .returning();
    return row?.id ?? '';
  }

  it('refuses a PR that touches a protected path (before any gh call)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let ghCalls = 0;
    const gh = async () => {
      ghCalls++;
      return { stdout: '', code: 0 };
    };
    const id = await makeItem('XTESTMAINT protected');
    const r = await openSelfMaintenancePR({ db, gh }, agentId, {
      itemId: id,
      branch: 'bot/fix-1',
      changedFiles: ['packages/core/src/browse.ts', 'packages/tools/src/registry.ts'],
      prTitle: 't',
      prBody: 'b',
    });
    expect(r.opened).toBe(false);
    expect(r.reason).toMatch(/blocked by the fence/);
    expect(ghCalls).toBe(0);
  });

  it('refuses to target a protected branch', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await makeItem('XTESTMAINT branch');
    const r = await openSelfMaintenancePR(
      { db, gh: async () => ({ stdout: '', code: 0 }) },
      agentId,
      {
        itemId: id,
        branch: 'main',
        changedFiles: ['packages/core/src/browse.ts'],
        prTitle: 't',
        prBody: 'b',
      },
    );
    expect(r.opened).toBe(false);
    expect(r.reason).toMatch(/protected branch/);
  });

  it('opens exactly one PR at a time (allowed files → gh → pr_open), refusing a second', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await makeItem('XTESTMAINT ok');
    const gh = async () => ({ stdout: 'https://github.com/bmson/aibot/pull/42\n', code: 0 });
    const first = await openSelfMaintenancePR({ db, gh }, agentId, {
      itemId: id,
      branch: 'bot/fix-selector',
      changedFiles: ['packages/core/src/browse.ts'],
      prTitle: 'Fix brittle selector',
      prBody: 'diagnosis + diff + test evidence',
    });
    expect(first.opened).toBe(true);
    expect(first.prUrl).toContain('/pull/42');
    const [row] = await db.select().from(selfMaintenance).where(eq(selfMaintenance.id, id));
    expect(row?.status).toBe('pr_open');

    // A second attempt is refused while one is open.
    const id2 = await makeItem('XTESTMAINT second');
    const second = await openSelfMaintenancePR({ db, gh }, agentId, {
      itemId: id2,
      branch: 'bot/fix-2',
      changedFiles: ['packages/core/src/browse.ts'],
      prTitle: 't',
      prBody: 'b',
    });
    expect(second.opened).toBe(false);
    expect(second.reason).toMatch(/already open/);
  });
});

describe('self-maintenance backlog (fence decides status)', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  const fakeRouter = {
    async object() {
      return {
        ok: true as const,
        modelId: 'fake',
        degraded: false,
        object: {
          items: [
            {
              codeShaped: true,
              title: 'XTESTMAINT fix the browse selector',
              diagnosis: 'the extract step used a brittle selector',
              targetArea: 'packages/core/src/browse.ts',
            },
            {
              codeShaped: true,
              title: 'XTESTMAINT loosen the approval gate',
              diagnosis: 'proposes editing the dispatcher',
              targetArea: 'packages/tools/src/dispatcher.ts',
            },
            { codeShaped: false, title: 'XTESTMAINT swap a model', diagnosis: '', targetArea: '' },
          ],
        },
      };
    },
  } as unknown as ModelRouter;

  async function cleanup() {
    await db.delete(selfMaintenance).where(like(selfMaintenance.title, 'XTESTMAINT%'));
    await db.delete(improvementProposals).where(like(improvementProposals.title, 'xtest-maint%'));
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
      await db.insert(improvementProposals).values({
        agentId,
        kind: 'note',
        title: 'xtest-maint-proposal',
        rationale: 'the browse selector is brittle',
      });
    } catch {
      console.warn('self-maintenance.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('files code-shaped items and records protected-path ones as blocked', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const r = await runSelfMaintenance({ db, router: fakeRouter });
    expect(r.backlog).toBeGreaterThanOrEqual(1);
    expect(r.blocked).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(selfMaintenance)
      .where(and(eq(selfMaintenance.agentId, agentId), like(selfMaintenance.title, 'XTESTMAINT%')));
    const bySelector = rows.find((x) => x.targetArea === 'packages/core/src/browse.ts');
    const byDispatcher = rows.find((x) => x.targetArea === 'packages/tools/src/dispatcher.ts');
    expect(bySelector?.status).toBe('backlog');
    expect(byDispatcher?.status).toBe('blocked');
    // The not-code-shaped item was skipped.
    expect(rows.some((x) => x.title.includes('swap a model'))).toBe(false);
  });
});
