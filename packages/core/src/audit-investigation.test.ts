import { randomUUID } from 'node:crypto';
import type { AuditInvestigationRepository, AuditTask } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { auditCursor, readAuditInvestigation, scrubAudit } from './audit-investigation.js';

const taskId = randomUUID();
const at = new Date('2026-09-30T01:00:00Z');
function repository() {
  return {
    task: vi.fn(
      async () =>
        ({
          id: taskId,
          agentId: 'owner',
          createdAt: at,
          trigger: {
            kind: 'chat',
            payload: { text: 'Send the email', access_token: 'secret-value' },
          },
          state: {
            callbackToken: 'runtime-token',
            lastError: 'provider timeout',
            requestChecklist: { items: [] },
          },
        }) as unknown as AuditTask,
    ),
    read: vi.fn(async () => []),
  };
}
describe('audit investigation evidence', () => {
  it('masks nested credentials, bearer headers, JSON text and signed URL keys while preserving useful evidence', () => {
    const clean = JSON.stringify(
      scrubAudit({
        authorization: 'Bearer sensitive',
        nested: { refresh_token: 'secret', error: 'provider timeout', passwordEncrypted: 'cipher' },
        text: 'Authorization=Bearer abcdef',
        json: '{"access_token":"hidden","message":"failed"}',
        url: 'https://provider.test?api_key=hidden&status=failed',
      }),
    );
    expect(clean).not.toContain('hidden');
    expect(clean).not.toContain('sensitive');
    expect(clean).not.toContain('cipher');
    expect(clean).toContain('provider timeout');
    expect(clean).toContain('status=failed');
  });
  it('does not read related records for another owner or a missing task', async () => {
    const repo = repository();
    repo.task.mockResolvedValueOnce(null as unknown as AuditTask);
    expect(await readAuditInvestigation(repo, 'other', taskId)).toBeNull();
    expect(repo.read).not.toHaveBeenCalled();
  });
  it('shows diagnostic state without leaking runtime state and marks missing model capture honestly', async () => {
    const report = await readAuditInvestigation(repository(), 'owner', taskId);
    const rendered = JSON.stringify(report);
    expect(rendered).toContain('provider timeout');
    expect(rendered).not.toContain('runtime-token');
    expect(rendered).not.toContain('secret-value');
    expect(report?.sections).toHaveLength(8);
    expect(rendered).toContain('retention window');
    expect(report?.investigationPrompt).toContain(taskId);
  });
  it('carries timestamp and ID continuations without losing equal-time entries', async () => {
    const repo = repository();
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    repo.read.mockResolvedValueOnce(
      ids.map((id) => ({ id, at, data: { error: 'failed' } })) as never,
    );
    const first = await readAuditInvestigation(repo, 'owner', taskId, {
      section: 'toolCalls',
      limit: 2,
    });
    const cursor = first?.sections[0]?.nextCursor as string;
    expect(auditCursor('toolCalls', cursor)).toEqual({ at, id: ids[1] });
    await readAuditInvestigation(repo, 'owner', taskId, { section: 'toolCalls', cursor, limit: 2 });
    expect(repo.read).toHaveBeenLastCalledWith('owner', taskId, {
      section: 'toolCalls',
      cursor: { at, id: ids[1] },
      limit: 3,
    });
    expect(() => auditCursor('modelCalls', cursor)).toThrow('Invalid audit cursor');
  });
  it('pages long sanitized fields with explicit total length and offset', async () => {
    const repo = repository();
    const id = randomUUID();
    const content = `${'x'.repeat(15000)}\nBearer private-token`;
    repo.read.mockResolvedValue([{ id, at, data: { input: content } }] as never);
    const report = await readAuditInvestigation(repo, 'owner', taskId, {
      section: 'modelCallAudit',
      entryId: id,
      field: 'input',
      offset: 12000,
    });
    const field = report?.sections[0]?.entries[0]?.fields.input;
    expect(field?.offset).toBe(12000);
    expect(field?.hasMore).toBe(false);
    expect(field?.text).toContain('Bearer [redacted]');
    expect(field?.text).not.toContain('private-token');
  });
  it('rejects nonprojected fields and invalid IDs before accessing the repository', async () => {
    const repo: AuditInvestigationRepository = repository();
    await expect(
      readAuditInvestigation(repo, 'owner', taskId, {
        section: 'messages',
        entryId: randomUUID(),
        field: 'embedding',
      }),
    ).rejects.toThrow('Invalid audit field');
    await expect(readAuditInvestigation(repo, 'owner', '../task')).rejects.toThrow(
      'Invalid task ID',
    );
    expect(repo.read).not.toHaveBeenCalled();
  });
});
