/**
 * The owner's Notifications chat: where background work without a chat of its
 * own reports. It is created on first use, and concurrent first uses converge
 * on one conversation.
 */
export interface NotificationsConversationRepository {
  readonly kind: 'notifications-conversation-repository';
  getOrCreate(agentId: string): Promise<string>;
}
