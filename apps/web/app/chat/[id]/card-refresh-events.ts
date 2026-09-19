/** Wake and prioritize the existing chat card after its refresh is acknowledged. */
export const CARD_REFRESH_EVENT = 'assistant:card-refresh';

export function requestCardPolling(cardId: string, taskId?: string): void {
  window.dispatchEvent(new CustomEvent(CARD_REFRESH_EVENT, { detail: { cardId, taskId } }));
}
