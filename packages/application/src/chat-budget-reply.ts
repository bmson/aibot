export function isApprovalReply(text: string): boolean {
  return /^(?:approved?|i approve(?: the budget increase)?)[.!\s]*$/i.test(text.trim());
}

/** Only the immediately preceding assistant message can define a bare approval. */
export function budgetReplyTarget(
  text: string,
  previous?: { text: string; taskId: string | null; parts: unknown },
): { taskId: string; amount: number } | undefined {
  if (!isApprovalReply(text) || !previous) return undefined;
  const parts = Array.isArray(previous.parts) ? previous.parts : [];
  const budgets = parts.filter((part) => part?.type === 'budget-request');
  if (budgets.length === 1) {
    const part = budgets[0];
    if (
      typeof part.taskId === 'string' &&
      typeof part.proposedBudgetUsd === 'number' &&
      Number.isFinite(part.proposedBudgetUsd) &&
      part.proposedBudgetUsd > 0 &&
      (!part.status || part.status === 'pending')
    ) {
      return { taskId: part.taskId, amount: part.proposedBudgetUsd };
    }
    return undefined;
  }
  if (budgets.length > 0) return undefined;
  // Compatibility with the exact runtime notice before structured cards shipped.
  const match =
    /^I need your permission to raise this task's spending limit from \$[\d.]+ to \$([\d.]+) so I can finish\./.exec(
      previous.text,
    );
  const amount = Number(match?.[1]);
  return match && previous.taskId && Number.isFinite(amount) && amount > 0
    ? { taskId: previous.taskId, amount }
    : undefined;
}
