import type { RepairIssue } from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { createGitHubRepairWorker } from './repair-github.js';

const issue: RepairIssue = {
  id: '00000000-0000-4000-a000-000000000001',
  agentId: 'owner',
  fingerprint: 'x',
  version: 0,
  status: 'fixing',
  createdAt: new Date(),
  updatedAt: new Date(),
  data: {
    source: 'feedback',
    title: 'PRIVATE TITLE',
    summary: 'PRIVATE OWNER FEEDBACK',
    diagnosis: 'Synthetic reminder case',
    targetPaths: ['packages/core/src/chat.ts'],
    reproduction: 'Create a fake reminder',
    acceptance: 'Deliver once',
    history: [],
  },
};
function worker(fetch: typeof globalThis.fetch) {
  return createGitHubRepairWorker({
    token: 'private-token',
    repo: 'owner/repo',
    workflow: 'self-repair.yml',
    ref: 'main',
    deploymentUrl: 'https://assistant.example',
    fetch,
  });
}
it('dispatches a technical brief without exporting owner feedback or source audit', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ private: true }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await worker(fetch).dispatch(issue);
  const [url, init] = fetch.mock.calls[1] ?? [];
  expect(url).toContain('/actions/workflows/self-repair.yml/dispatches');
  expect(init.body).not.toContain('PRIVATE');
  expect(JSON.parse(init.body).inputs.repair_id).toBe(issue.id);
});
it('refuses diagnostic export to a public repository', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ private: false }));
  await expect(worker(fetch).dispatch(issue)).rejects.toThrow('private repository');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reads exact PR merge state and never merges automatically', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        {
          number: 1,
          head: { ref: `codex/self-repair-${issue.id}`, repo: { full_name: 'owner/repo' } },
        },
      ]),
    )
    .mockResolvedValueOnce(
      Response.json({
        number: 1,
        state: 'closed',
        merged_at: '2026-09-30',
        merge_commit_sha: 'a'.repeat(40),
      }),
    );
  expect(await worker(fetch).inspect(issue)).toMatchObject({
    status: 'merged',
    patch: { mergeSha: 'a'.repeat(40) },
  });
  expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});
it('waits for successful health and verifies that deployment includes the merged commit', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ sha: 'b'.repeat(40) }))
    .mockResolvedValueOnce(Response.json({ status: 'behind' }));
  expect(await worker(fetch).deployed('a'.repeat(40))).toBe(false);
  fetch
    .mockResolvedValueOnce(Response.json({ sha: 'b'.repeat(40) }))
    .mockResolvedValueOnce(Response.json({ status: 'ahead' }));
  expect(await worker(fetch).deployed('a'.repeat(40))).toBe(true);
});
it('tracks verify jobs as testing rather than claiming a PR exists', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({
        workflow_runs: [
          { id: 10, display_title: `self-repair:${issue.id}`, status: 'in_progress' },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ jobs: [{ name: 'verify', status: 'in_progress' }] }));
  expect(await worker(fetch).inspect(issue)).toMatchObject({ status: 'testing' });
});
