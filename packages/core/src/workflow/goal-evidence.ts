/**
 * Tools that only inspect or rewrite the assistant's own bookkeeping do not
 * prove that an unattended goal session advanced the owner's outcome.
 */
const GOAL_BOOKKEEPING_TOOLS = new Set([
  'browser.plan',
  'conversations.search',
  'goals.list',
  'goals.update_progress',
  'memory.recall',
  'mission.update',
  'owner.notify',
  'task.schedule',
  'workspace.list',
  'workspace.read',
]);

export function isGoalWorkEvidenceTool(toolName: string): boolean {
  return !GOAL_BOOKKEEPING_TOOLS.has(toolName);
}

export interface GoalToolEvidence {
  toolName: string;
  status: string;
  result: unknown;
}

/** Database success is not enough when a tool reports failure in its result payload. */
export function isGoalWorkEvidence(evidence: GoalToolEvidence): boolean {
  if (evidence.status !== 'succeeded' || !isGoalWorkEvidenceTool(evidence.toolName)) return false;
  if (!evidence.result || typeof evidence.result !== 'object') return true;
  const result = evidence.result as Record<string, unknown>;
  return (
    result.ok !== false &&
    !(typeof result.status === 'number' && result.status >= 400) &&
    result.deliveryStatus !== 'unknown'
  );
}

export function needsGoalProgressToolRetry(toolCalls: Array<{ toolName: string }>): boolean {
  return !toolCalls.some((toolCall) => toolCall.toolName === 'goals.update_progress');
}
