/**
 * Live proof that a goal's automatic work session actually drives tools.
 *
 * Creates a throwaway goal + work chat, enqueues one scheduled session exactly
 * as the goal scheduler would, and runs it through the real executor with the
 * real model router and the real tool registry. Prints every tool call the
 * session made, so "it works now" is a claim backed by rows in tool_calls
 * rather than by the model's own prose.
 *
 *   pnpm tsx scripts/verify-goal-session.ts ["goal description"]
 *
 * Costs real OpenRouter credit. Writes to DATABASE_URL (local by default) and
 * removes everything it created before exiting.
 */
import { ensureGoalAutomation, executeTask, getAgent, runDueSchedules } from '@assistant/core';
import {
  approvals,
  conversations,
  costEvents,
  costReservations,
  goals,
  messages,
  modelCalls,
  schedules,
  tasks,
  toolCalls,
} from '@assistant/db';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { buildDeps } from '../apps/agent/src/deps.js';
import { executorDeps } from '../apps/agent/src/executor-deps.js';

const description =
  process.argv[2] ??
  'Help me find a new job. I am a senior staff frontend engineer. I want applied-AI or frontend/UI/product roles at AI companies, remote or San Francisco, minimum $250K total comp.';

const deps = buildDeps();
const db = deps.db;
const agent = await getAgent(db);

const [goal] = await db
  .insert(goals)
  .values({
    agentId: agent.id,
    title: 'Verify goal session',
    description,
    // A genuinely new goal, with no prior progress to carry forward. Seeding
    // the old "check the work chat for the first update" line here would just
    // test whether the model follows a misleading instruction (it does).
    progress: '',
    nextAction: '',
  })
  .returning({ id: goals.id });
if (!goal) throw new Error('failed to create verification goal');
const goalId = goal.id;

const [conversation] = await db
  .insert(conversations)
  .values({
    agentId: agent.id,
    channel: 'chat',
    trust: 'owner',
    title: 'Work: Verify goal session',
    metadata: { goalId },
  })
  .returning({ id: conversations.id });
if (!conversation) throw new Error('failed to create verification work chat');
const conversationId = conversation.id;

// Go through the real scheduler so the session gets the exact instruction,
// budget, and step cap production would give it — a hand-written trigger here
// would prove nothing about what actually runs at 09:15.
const [goalRow] = await db.select().from(goals).where(eq(goals.id, goalId));
if (!goalRow) throw new Error('verification goal disappeared');
const schedule = await ensureGoalAutomation(db, agent, goalRow);
if (!schedule) throw new Error('goal automation was not created');
await db
  .update(schedules)
  .set({ nextRunAt: new Date(Date.now() - 1000) })
  .where(eq(schedules.id, schedule.id));
await runDueSchedules(db);

const [task] = await db
  .select()
  .from(tasks)
  .where(eq(tasks.goalId, goalId))
  .orderBy(desc(tasks.createdAt))
  .limit(1);
if (!task) throw new Error('scheduler produced no goal session');

console.log(`goal ${goalId}\ntask ${task.id}\nrunning…\n`);
const outcome = await executeTask(executorDeps(deps), task.id);

const calls = await db
  .select({
    step: toolCalls.step,
    toolName: toolCalls.toolName,
    status: toolCalls.status,
    error: toolCalls.error,
  })
  .from(toolCalls)
  .where(eq(toolCalls.taskId, task.id))
  .orderBy(asc(toolCalls.step));

const models = await db
  .select({ role: modelCalls.role, model: modelCalls.model, finish: modelCalls.finishReason })
  .from(modelCalls)
  .where(eq(modelCalls.taskId, task.id))
  .orderBy(asc(modelCalls.createdAt));

const [finished] = await db.select().from(tasks).where(eq(tasks.id, task.id));
const [finalGoal] = await db.select().from(goals).where(eq(goals.id, goalId));

console.log('outcome     ', outcome);
console.log('task status ', finished?.status);
console.log('spent USD   ', finished?.spentUsd);
console.log('\nmodel calls:');
for (const m of models) console.log(`  ${m.role.padEnd(9)} ${m.model} (${m.finish})`);
console.log(`\ntool calls (${calls.length}):`);
for (const c of calls) {
  console.log(`  step ${c.step}: ${c.toolName} → ${c.status}${c.error ? ` (${c.error})` : ''}`);
}
console.log('\ngoal progress   ', finalGoal?.progress);
console.log('goal nextAction ', finalGoal?.nextAction);

const reply = await db
  .select({ text: messages.text })
  .from(messages)
  .where(eq(messages.taskId, task.id))
  .orderBy(asc(messages.createdAt));
console.log(
  '\nsession said:\n',
  reply
    .map((r) => r.text)
    .join('\n---\n')
    .slice(0, 1500),
);

// Clean up: this is a throwaway goal, not part of the owner's real state.
// Dependency order: approvals → tool_calls, cost_events → cost_reservations.
await db.delete(costEvents).where(inArray(costEvents.taskId, [task.id]));
await db.delete(costReservations).where(inArray(costReservations.taskId, [task.id]));
// tool_calls.approval_id and approvals.tool_call_id reference each other.
await db
  .update(toolCalls)
  .set({ approvalId: null })
  .where(inArray(toolCalls.taskId, [task.id]));
await db.delete(approvals).where(inArray(approvals.taskId, [task.id]));
await db.delete(toolCalls).where(inArray(toolCalls.taskId, [task.id]));
await db.delete(modelCalls).where(inArray(modelCalls.taskId, [task.id]));
await db.delete(messages).where(inArray(messages.conversationId, [conversationId]));
await db.delete(tasks).where(inArray(tasks.id, [task.id]));
await db.delete(conversations).where(inArray(conversations.id, [conversationId]));
await db.delete(schedules).where(eq(schedules.id, schedule.id));
await db.delete(goals).where(inArray(goals.id, [goalId]));
process.exit(0);
