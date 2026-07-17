import { type AgentRow, type Db, type TaskRow, tasks } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { persistMessage } from '../chat.js';
import { InboundEventSchema, type Plan, type TaskState } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';
import {
  checkpointTask,
  completeTask,
  enqueueTask,
  markTaskNeedsAttention,
  parkForEvent,
  renewTaskLease,
  sleepTask,
  type TaskLease,
  taskState,
} from './machine.js';

const DEFAULT_MISSION_DAYS = 30;
const DEFAULT_WAKE_HOURS = 24;
const DEFAULT_REFLECT_DAYS = 7;
const MAX_MISSION_BUDGET_USD = 5;

export const ReflectionSchema = z.object({
  decision: z.enum(['continue', 'pause', 'escalate', 'complete', 'abandon']),
  reasoning: z.string().default(''),
  progressPercent: z.number().int().min(0).max(100).nullish(),
});
export type Reflection = z.infer<typeof ReflectionSchema>;

/**
 * Planner said 'mission': create a first-class long-horizon task and let the
 * triggering task finish with a confirmation. Missions wake, work in fresh
 * bounded sessions, sleep, and reflect — never one endless transcript.
 */
export async function startMission(
  db: Db,
  source: TaskRow,
  plan: Plan,
  missionStatement: string,
): Promise<TaskRow> {
  let deadline = new Date(Date.now() + DEFAULT_MISSION_DAYS * 24 * 3600 * 1000);
  if (plan.deadline) {
    const parsed = new Date(plan.deadline);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) deadline = parsed;
  }
  const budget = Math.min(plan.budgetSuggestionUsd ?? 2, MAX_MISSION_BUDGET_USD);

  const event = InboundEventSchema.parse({
    source: 'internal',
    externalEventId: `mission:source:${source.id}`,
    agentId: source.agentId,
    conversationId: source.conversationId ?? undefined,
    trust: source.trust,
    payload: { instruction: missionStatement, plan: plan.steps },
  });
  const { task: mission } = await enqueueTask(db, {
    event,
    type: 'mission',
    goalId: source.goalId ?? plan.goalId,
    budgetUsdLimit: budget.toFixed(4),
    deadline,
  });
  await db
    .update(tasks)
    .set({
      reflectEvery: sql`interval '${sql.raw(String(DEFAULT_REFLECT_DAYS))} days'`,
      nextAction: plan.steps[0] ?? '',
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, mission.id));
  return mission;
}

function missionInstruction(mission: TaskRow): string {
  const trigger = mission.trigger as { payload?: { instruction?: string } };
  return trigger.payload?.instruction ?? '(no mission statement)';
}

/** Compose the seed instruction for a fresh work session from durable mission state. */
function sessionInstruction(mission: TaskRow, state: TaskState): string {
  return [
    `You are running one work session of an ongoing mission. Mission: ${missionInstruction(mission)}`,
    mission.deadline ? `Mission deadline: ${mission.deadline.toISOString()}` : '',
    mission.progress ? `Progress so far: ${mission.progress}` : 'This is the first session.',
    mission.nextAction ? `Planned next action: ${mission.nextAction}` : '',
    state.scratchpad ? `Notes from previous sessions: ${state.scratchpad}` : '',
    'Do the next concrete increment of work now. Before finishing, call mission.update with your progress, an updated next action, and any notes for the next session. Do NOT use task.schedule — the mission wakes you automatically on its own cadence.',
  ]
    .filter(Boolean)
    .join('\n');
}

export type MissionWake =
  | { action: 'sessioned'; sessionTaskId: string; sleptUntil: Date }
  | { action: 'reflected'; decision: Reflection['decision']; sleptUntil?: Date }
  | { action: 'deadline_reached' }
  | { action: 'lease_lost' };

/**
 * One mission wake (the mission task was claimed). Deadline → final report.
 * Reflection due → reflect and apply the decision. Otherwise spawn a fresh
 * session child and go back to sleep.
 */
export async function wakeMission(
  deps: { db: Db; router: ModelRouter },
  mission: TaskLease,
  agent: AgentRow,
): Promise<MissionWake> {
  const { db } = deps;
  const state = taskState(mission);

  if (mission.deadline && mission.deadline.getTime() <= Date.now()) {
    const completed = await completeTask(db, mission, {
      status: 'done',
      progress: `deadline reached — ${mission.progress || 'no progress recorded'}`,
    });
    if (!completed) return { action: 'lease_lost' };
    await report(
      db,
      mission,
      `Mission reached its deadline. Final status: ${mission.progress || 'no progress recorded'}`,
    );
    return { action: 'deadline_reached' };
  }

  const reflectMs = parseIntervalMs(mission.reflectEvery) ?? DEFAULT_REFLECT_DAYS * 24 * 3600e3;
  const lastReflected = mission.lastReflectedAt ?? mission.createdAt;
  if (Date.now() - lastReflected.getTime() >= reflectMs) {
    return reflect(deps, mission, agent, state);
  }

  // Fence immediately before creating the child. An old worker must not
  // spawn new mission work after the owner cancelled or another lease won.
  if (!(await renewTaskLease(db, mission))) return { action: 'lease_lost' };
  const { task: session } = await enqueueTask(db, {
    event: InboundEventSchema.parse({
      source: 'mission_wake',
      externalEventId: `mission:${mission.id}:session:${state.step}`,
      agentId: mission.agentId,
      conversationId: mission.conversationId ?? undefined,
      trust: mission.trust,
      payload: { instruction: sessionInstruction(mission, state), missionId: mission.id },
    }),
    type: 'adhoc',
    parentTaskId: mission.id,
    budgetUsdLimit: '0.25',
  });

  state.step += 1; // counts sessions for the mission
  const wakeAt = new Date(Date.now() + DEFAULT_WAKE_HOURS * 3600e3);
  if (!(await renewTaskLease(db, mission))) return { action: 'lease_lost' };
  if (!(await sleepTask(db, mission, state, wakeAt))) return { action: 'lease_lost' };
  return { action: 'sessioned', sessionTaskId: session.id, sleptUntil: wakeAt };
}

async function reflect(
  deps: { db: Db; router: ModelRouter },
  mission: TaskLease,
  _agent: AgentRow,
  state: TaskState,
): Promise<MissionWake> {
  const { db, router } = deps;
  const outcome = await router.object<Reflection>('reason', {
    taskId: mission.id,
    schema: ReflectionSchema,
    system: [
      'You are reflecting on a long-running mission: is it still worth pursuing?',
      "Decide: 'continue' (making progress), 'pause' (blocked, wait for the owner), 'escalate' (needs the owner's attention/decision), 'complete' (goal achieved), 'abandon' (no longer worth it).",
      'Estimate progressPercent if possible.',
    ].join('\n'),
    prompt: [
      `Mission: ${missionInstruction(mission)}`,
      `Deadline: ${mission.deadline?.toISOString() ?? 'none'}`,
      `Progress: ${mission.progress || 'none recorded'}`,
      `Next action: ${mission.nextAction || 'none'}`,
      `Session notes: ${state.scratchpad || 'none'}`,
      `Sessions run: ${state.step}`,
    ].join('\n'),
  });

  const reflection: Reflection = outcome.ok
    ? outcome.object
    : { decision: 'escalate', reasoning: 'reflection blocked by budget', progressPercent: null };

  if (!(await renewTaskLease(db, mission))) return { action: 'lease_lost' };
  if (
    !(await checkpointTask(db, mission, state, {
      lastReflectedAt: new Date(),
      progressPercent: reflection.progressPercent ?? mission.progressPercent,
    }))
  ) {
    return { action: 'lease_lost' };
  }

  switch (reflection.decision) {
    case 'continue': {
      const wakeAt = new Date(Date.now() + DEFAULT_WAKE_HOURS * 3600e3);
      if (!(await sleepTask(db, mission, state, wakeAt))) return { action: 'lease_lost' };
      return { action: 'reflected', decision: 'continue', sleptUntil: wakeAt };
    }
    case 'pause': {
      if (!(await parkForEvent(db, mission))) return { action: 'lease_lost' };
      await report(
        db,
        mission,
        `Mission paused after reflection: ${reflection.reasoning}. Wake it from the dashboard when ready.`,
      );
      return { action: 'reflected', decision: 'pause' };
    }
    case 'escalate': {
      if (!(await markTaskNeedsAttention(db, mission, `escalated: ${reflection.reasoning}`))) {
        return { action: 'lease_lost' };
      }
      await report(db, mission, `Mission needs your attention: ${reflection.reasoning}`);
      return { action: 'reflected', decision: 'escalate' };
    }
    case 'complete': {
      if (!(await completeTask(db, mission, { status: 'done', progress: mission.progress }))) {
        return { action: 'lease_lost' };
      }
      await report(db, mission, `Mission complete: ${reflection.reasoning}`);
      return { action: 'reflected', decision: 'complete' };
    }
    case 'abandon': {
      if (
        !(await completeTask(db, mission, {
          status: 'cancelled',
          progress: reflection.reasoning,
        }))
      ) {
        return { action: 'lease_lost' };
      }
      await report(db, mission, `Mission abandoned after reflection: ${reflection.reasoning}`);
      return { action: 'reflected', decision: 'abandon' };
    }
  }
}

/** Post a mission update where the owner will see it (its conversation, if any). */
async function report(db: Db, mission: TaskRow, text: string): Promise<void> {
  if (!mission.conversationId) return;
  await persistMessage(db, {
    conversationId: mission.conversationId,
    taskId: mission.id,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
  });
}

/** Postgres interval → ms (supports the shapes we write: 'N days', 'HH:MM:SS'). */
export function parseIntervalMs(interval: unknown): number | null {
  if (!interval) return null;
  const s = String(interval);
  const days = s.match(/(\d+)\s*day/);
  const time = s.match(/(\d+):(\d+):(\d+)/);
  let ms = 0;
  if (days?.[1]) ms += Number(days[1]) * 24 * 3600e3;
  if (time) ms += Number(time[1]) * 3600e3 + Number(time[2]) * 60e3 + Number(time[3]) * 1e3;
  return ms > 0 ? ms : null;
}
