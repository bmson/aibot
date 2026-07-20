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
