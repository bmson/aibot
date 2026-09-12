import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWorkspaceSnapshot } from './workspace-migration.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && new URL(databaseUrl).pathname.endsWith('_test'));

describe.skipIf(!enabled)('PostgreSQL workspace migration export', () => {
  const ids = {
    agent: randomUUID(),
    conversation: randomUUID(),
    task: randomUUID(),
    message: randomUUID(),
  };
  let sql: postgres.Sql;

  afterEach(async () => {
    if (!sql) return;
    await sql`delete from messages where id = ${ids.message}`;
    await sql`delete from tasks where id = ${ids.task}`;
    await sql`delete from conversations where id = ${ids.conversation}`;
    await sql`delete from agents where id = ${ids.agent}`;
    await sql.end({ timeout: 5 });
    sql = undefined as unknown as postgres.Sql;
  });

  it('exports a consistent, workspace-scoped snapshot with deterministic record checksums', async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await sql`insert into agents (id, name, email, workspace_prefix) values (${ids.agent}, 'Migration test owner', ${`${ids.agent}@example.test`}, ${`workspace/${ids.agent}`})`;
    await sql`insert into conversations (id, agent_id, channel, trust) values (${ids.conversation}, ${ids.agent}, 'chat', 'owner')`;
    await sql`insert into tasks (id, agent_id, type, status, conversation_id, trust) values (${ids.task}, ${ids.agent}, 'adhoc', 'waiting_event', ${ids.conversation}, 'owner')`;
    await sql`insert into messages (id, conversation_id, task_id, role, parts, text, origin) values (${ids.message}, ${ids.conversation}, ${ids.task}, 'assistant', ${sql.json([])}, 'snapshot message', 'assistant')`;

    const bundle = await exportWorkspaceSnapshot({
      databaseUrl,
      agentId: ids.agent,
      target: {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: 'migration-test',
      },
      tables: ['agents', 'conversations', 'messages', 'tasks'],
    });

    expect(bundle.manifest.source.kind).toBe('postgresql');
    expect(bundle.manifest.source.agentId).toBe(ids.agent);
    expect(bundle.records.map((record) => `${record.table}/${record.id}`)).toEqual([
      `agents/${ids.agent}`,
      `conversations/${ids.conversation}`,
      `messages/${ids.message}`,
      `tasks/${ids.task}`,
    ]);
    expect(bundle.records.find((record) => record.table === 'messages')?.data.text).toBe(
      'snapshot message',
    );
    expect(bundle.manifest.recordCount).toBe(4);
    expect(bundle.manifest.bundleChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects installation-wide export when PostgreSQL has multiple agents', async () => {
    if (!databaseUrl) return;
    const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const second = randomUUID();
    try {
      await client`insert into agents (id, name, email, workspace_prefix) values (${second}, 'Second', ${`${second}@example.test`}, ${`workspace/${second}`})`;
      await expect(
        exportWorkspaceSnapshot({
          databaseUrl,
          agentId: ids.agent,
          target: { projectId: 'demo', databaseId: '(default)', installationId: 'x' },
          tables: ['agents', 'contacts'],
        }),
      ).rejects.toThrow('exactly one PostgreSQL agent');
      await client`delete from agents where id = ${second}`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
