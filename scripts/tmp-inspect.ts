import { approvals, createDb, messages, tasks, toolCalls } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';

const db = createDb(process.env.PROD_DATABASE_URL as string);
const convId = '9f904cc0-5c67-46e3-b930-ec11b9b91f57';

const msgs = await db
  .select()
  .from(messages)
  .where(eq(messages.conversationId, convId))
  .orderBy(messages.createdAt);
console.log('=== MESSAGES ===');
for (const m of msgs)
  console.log(m.createdAt.toISOString(), m.role, '|', m.text.slice(0, 200).replace(/\n/g, ' '));

const taskRows = await db
  .select()
  .from(tasks)
  .where(eq(tasks.conversationId, convId))
  .orderBy(tasks.createdAt);
console.log('\n=== TASKS ===');
for (const t of taskRows)
  console.log(
    t.createdAt.toISOString(),
    t.id.slice(0, 8),
    t.type,
    t.status,
    '| progress:',
    (t.progress ?? '').slice(0, 150),
    '| spent:',
    t.spentUsd,
  );

if (taskRows.length) {
  const calls = await db
    .select()
    .from(toolCalls)
    .where(
      inArray(
        toolCalls.taskId,
        taskRows.map((t) => t.id),
      ),
    )
    .orderBy(toolCalls.createdAt);
  console.log('\n=== TOOL CALLS ===');
  for (const c of calls)
    console.log(
      c.createdAt.toISOString(),
      c.taskId.slice(0, 8),
      c.toolName,
      c.status,
      '| err:',
      (c.error ?? '').slice(0, 150),
      '| args:',
      JSON.stringify(c.args).slice(0, 150),
    );
  const apps = await db
    .select()
    .from(approvals)
    .where(
      inArray(
        approvals.taskId,
        taskRows.map((t) => t.id),
      ),
    );
  console.log('\n=== APPROVALS ===');
  for (const a of apps)
    console.log(
      a.requestedAt.toISOString(),
      a.shortCode,
      a.status,
      '|',
      a.summary.slice(0, 150),
      '| resolvedVia:',
      a.resolvedVia,
      '| expires:',
      a.expiresAt.toISOString(),
    );
}
process.exit(0);
