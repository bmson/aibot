import type { TaskRow } from '@assistant/db';
import type { Plan } from '../../events.js';
import type { ModelRole } from '../../model-router/router.js';
import { isUnattendedGoalSession } from './context-helpers.js';

const ROLE_FOR_TYPE: Record<string, ModelRole> = {
  chat_turn: 'draft',
  sms_turn: 'draft',
  email_triage: 'draft',
  scheduled: 'draft',
  mission: 'reason',
  browser_job: 'draft',
  adhoc: 'draft',
};

/** Interactive/action types whose non-trivial requests should reason with tools. */
const ACTION_ROUTED_TYPES = new Set(['chat_turn', 'sms_turn', 'scheduled']);

/**
 * Which model tier runs a task's tool loop. The reasoning model (Claude) is not
 * reserved for background missions: any request that intends to DO something —
 * an unattended goal session, a mission, an email to triage, a mission work
 * session (adhoc), or a chat/SMS/scheduled turn the planner routed to real work
 * (action !== 'reply') — drives its tools on the strong model. Trivial
 * conversation (the planner's classify short-circuit returns a null plan, or a
 * 'reply' action) stays on the cheap draft model.
 *
 * This is the single biggest competence lever: before it, every interactive
 * "do this for me" request ran its tool-calling loop on the draft model, which
 * answers with plausible prose and no tool calls.
 */
export function roleForTask(task: Pick<TaskRow, 'type' | 'goalId'>, plan: Plan | null): ModelRole {
  if (isUnattendedGoalSession(task)) return 'reason';
  const base = ROLE_FOR_TYPE[task.type] ?? 'draft';
  if (base === 'reason') return 'reason';
  // Email triage and mission sessions are inherently action-oriented.
  if (task.type === 'email_triage' || task.type === 'adhoc') return 'reason';
  if (ACTION_ROUTED_TYPES.has(task.type) && plan && plan.action !== 'reply') return 'reason';
  return base;
}
