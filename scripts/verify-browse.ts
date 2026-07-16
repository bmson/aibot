/**
 * Phase 6 live verification: enqueue a real read-only browse task and watch it
 * run through plan → browser job → callback → answer.
 *
 * Usage:
 *   pnpm tsx scripts/verify-browse.ts --prod            # enqueue in prod
 *   pnpm tsx scripts/verify-browse.ts --prod --watch <taskId>
 */
import { loadConfig } from '@assistant/core';
import { agents, conversations, createDb, messages, tasks, toolCalls } from '@assistant/db';
import { desc, eq } from 'drizzle-orm';

const prod = process.argv.includes('--prod');
const config = loadConfig();
const dbUrl = prod ? process.env.PROD_DATABASE_URL : config.DATABASE_URL;
if (!dbUrl) {
  console.error(prod ? 'PROD_DATABASE_URL missing from .env' : 'DATABASE_URL missing');
  process.exit(1);
}
const db = createDb(dbUrl);

const goalIndex = process.argv.indexOf('--goal');
const INSTRUCTION =
  goalIndex !== -1 && process.argv[goalIndex + 1]
    ? (process.argv[goalIndex + 1] as string)
    : 'Use the Workspace browser for this (browser.plan, then browser.execute with a read-only plan): ' +
      'open https://news.ycombinator.com and tell me the current #1 story title. ' +
      'Reply with just the headline and its rank.';

const watchIndex = process.argv.indexOf('--watch');

async function enqueue() {
  const [agent] = await db.select().from(agents).limit(1);
  if (!agent) throw new Error('no agent row');

  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: agent.id,
      channel: 'chat',
      trust: 'owner',
      title: 'Phase 6 browser live test',
    })
    .returning();
  if (!conversation) throw new Error('conversation insert failed');

  await db.insert(messages).values({
    conversationId: conversation.id,
    role: 'user',
    origin: 'owner',
    parts: [{ type: 'text', text: INSTRUCTION }],
    text: INSTRUCTION,
  });

  const [task] = await db
    .insert(tasks)
    .values({
      agentId: agent.id,
      conversationId: conversation.id,
      type: 'adhoc',
      status: 'pending',
      trust: 'owner',
      trigger: {
        source: 'internal',
        agentId: agent.id,
        trust: 'owner',
        payload: { instruction: INSTRUCTION, note: 'phase 6 live verification' },
      },
    })
    .returning();
  if (!task) throw new Error('task insert failed');

  console.log(`task ${task.id}`);
  console.log(`conversation ${conversation.id}`);
  console.log('the per-minute sweeper will pick it up; watch with:');
  console.log(`  pnpm tsx scripts/verify-browse.ts ${prod ? '--prod ' : ''}--watch ${task.id}`);
}

async function watch(taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error('task not found');
  console.log(
    JSON.stringify(
      {
        status: task.status,
        attempt: task.attempt,
        progress: task.progress,
        runAfter: task.runAfter,
        spentUsd: task.spentUsd,
        pendingJob: (task.state as { pendingJob?: unknown } | null)?.pendingJob ?? null,
      },
      null,
      2,
    ),
  );
  const calls = await db
    .select()
    .from(toolCalls)
    .where(eq(toolCalls.taskId, taskId))
    .orderBy(toolCalls.step);
  for (const c of calls) {
    console.log(
      `#${c.step} ${c.toolName} [${c.status}] ${JSON.stringify(c.result ?? c.error ?? '').slice(0, 300)}`,
    );
  }
  if (task.conversationId) {
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, task.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(3);
    for (const m of msgs.reverse()) console.log(`[${m.role}] ${m.text?.slice(0, 300)}`);
  }
}

if (watchIndex !== -1) {
  const taskId = process.argv[watchIndex + 1];
  if (!taskId) throw new Error('--watch needs a task id');
  await watch(taskId);
} else {
  await enqueue();
}
await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
