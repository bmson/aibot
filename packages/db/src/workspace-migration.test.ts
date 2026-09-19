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
    file: randomUUID(),
    message: randomUUID(),
    message2: randomUUID(),
    mailbox: `migration-${randomUUID()}@example.test`,
  };
  let sql: postgres.Sql;

  afterEach(async () => {
    if (!sql) return;
    await sql`delete from gmail_sync_state where mailbox = ${ids.mailbox}`;
    await sql`delete from files where id = ${ids.file}`;
    await sql`delete from messages where id = ${ids.message}`;
    await sql`delete from messages where id = ${ids.message2}`;
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
    await sql`insert into messages (id, conversation_id, task_id, role, parts, text, origin, created_at) values (${ids.message}, ${ids.conversation}, ${ids.task}, 'assistant', ${sql.json([])}, 'snapshot message', 'assistant', '2026-09-19 12:34:56.123456+00'::timestamptz), (${ids.message2}, ${ids.conversation}, ${ids.task}, 'assistant', ${sql.json([])}, 'snapshot message 2', 'assistant', '2026-09-19 12:34:56.123789+00'::timestamptz)`;
    await sql`insert into files (id, agent_id, workspace_path, bytes) values (${ids.file}, ${ids.agent}, 'migration/precision.bin', ${Number.MAX_SAFE_INTEGER})`;

    const bundle = await exportWorkspaceSnapshot({
      databaseUrl,
      agentId: ids.agent,
      target: {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: 'migration-test',
      },
      tables: ['agents', 'conversations', 'files', 'messages', 'tasks'],
    });

    expect(bundle.manifest.source.kind).toBe('postgresql');
    expect(bundle.manifest.source.agentId).toBe(ids.agent);
    expect(bundle.records.map((record) => `${record.table}/${record.id}`)).toEqual(
      [
        `agents/${ids.agent}`,
        `conversations/${ids.conversation}`,
        `files/${ids.file}`,
        `messages/${ids.message}`,
        `messages/${ids.message2}`,
        `tasks/${ids.task}`,
      ].sort(),
    );
    expect(bundle.records.find((record) => record.id === ids.message)?.data.text).toBe(
      'snapshot message',
    );
    const messageRecords = bundle.records.filter((record) => record.table === 'messages');
    expect(messageRecords.find((record) => record.id === ids.message)?.data.createdAt).toEqual({
      $assistantMigration: ['timestamp', '2026-09-19T12:34:56.123456Z'],
    });
    expect(messageRecords.find((record) => record.id === ids.message2)?.data.createdAt).toEqual({
      $assistantMigration: ['timestamp', '2026-09-19T12:34:56.123789Z'],
    });
    expect(messageRecords.find((record) => record.id === ids.message)?.checksum).not.toBe(
      messageRecords.find((record) => record.id === ids.message2)?.checksum,
    );
    expect(bundle.manifest.formatVersion).toBe(3);
    expect(bundle.records.find((record) => record.id === ids.file)?.data.bytes).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(bundle.manifest.recordCount).toBe(6);
    expect(bundle.manifest.bundleChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exports every declared PostgreSQL table for a single-owner installation', async () => {
    if (!databaseUrl) return;
    sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const [owner] = await sql<{ id: string }[]>`select id from agents`;
    if (!owner) throw new Error('seeded owner missing');
    await sql`insert into gmail_sync_state (mailbox, last_history_id) values (${ids.mailbox}, 9223372036854775807)`;
    const complete = await exportWorkspaceSnapshot({
      databaseUrl,
      agentId: owner.id,
      target: {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: 'migration-test',
      },
      embeddingSpace: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        revision: '1',
      },
    });
    expect(Object.keys(complete.manifest.tables)).toHaveLength(66);
    expect(complete.manifest.coverage).toEqual({
      complete: true,
      supportedTables: expect.arrayContaining(['agents', 'messages', 'knowledge_graph_relations']),
      omittedTables: [],
    });
    expect(
      complete.records.find(
        (record) => record.table === 'gmail_sync_state' && record.id === ids.mailbox,
      )?.data.lastHistoryId,
    ).toEqual({ $assistantMigration: ['bigint', '9223372036854775807'] });
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
