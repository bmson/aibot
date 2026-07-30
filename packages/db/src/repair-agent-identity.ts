import { loadConfig } from '@assistant/config';
import postgres from 'postgres';

const { DATABASE_URL } = loadConfig();
const sql = postgres(DATABASE_URL, { max: 1 });

try {
  await sql.begin(async (tx) => {
    const [agentCount] = await tx<{ count: number }[]>`
      select count(*)::int as count from agents
    `;

    if (!agentCount || agentCount.count <= 1) return;

    const [canonical] = await tx<{ id: string }[]>`
      select id
      from agents
      order by created_at asc, id asc
      limit 1
    `;
    const [latest] = await tx<{ email: string; name: string }[]>`
      select email, name
      from agents
      order by created_at desc, id desc
      limit 1
    `;

    if (!canonical || !latest) throw new Error('could not resolve agent identities');

    const canonicalId = canonical.id;

    await tx`
      update conversations
      set is_primary = false
      where agent_id <> ${canonicalId}
        and is_primary = true
    `;

    await tx`
      delete from approval_policies
      where agent_id <> ${canonicalId}
        and created_via = 'seed'
    `;

    const foreignKeys = await tx<{ tableName: string; columnName: string }[]>`
      select
        conrelid::regclass::text as "tableName",
        a.attname as "columnName"
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum = c.conkey[1]
      where c.contype = 'f'
        and c.confrelid = 'agents'::regclass
        and array_length(c.conkey, 1) = 1
    `;

    for (const foreignKey of foreignKeys) {
      await tx.unsafe(
        `update ${foreignKey.tableName} set "${foreignKey.columnName}" = $1 where "${foreignKey.columnName}" <> $1`,
        [canonicalId],
      );
    }

    const duplicates = await tx<{ id: string }[]>`
      select id from agents where id <> ${canonicalId}
    `;

    for (const duplicate of duplicates) {
      await tx`
        update agents
        set email = ${`recovered-${duplicate.id}@invalid.local`}
        where id = ${duplicate.id}
      `;
    }

    await tx`
      update agents
      set email = ${latest.email},
          name = ${latest.name},
          updated_at = now()
      where id = ${canonicalId}
    `;

    await tx`delete from agents where id <> ${canonicalId}`;

    console.log(`reconciled ${duplicates.length + 1} agent rows into ${canonicalId}`);
  });
} finally {
  await sql.end();
}
