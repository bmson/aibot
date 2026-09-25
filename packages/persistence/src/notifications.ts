/**
 * The owner's Notifications chat: where background work without a chat of its
 * own reports. It is created on first use, and concurrent first uses converge
 * on one conversation.
 */
export interface NotificationsConversationRepository {
  readonly kind: 'notifications-conversation-repository';
  getOrCreate(agentId: string): Promise<string>;
}

/**
 * A background producer's dashboard copy (briefing, pulse, curiosity): the
 * owner's primary chat when there is one, otherwise their Notifications chat.
 */
export interface OwnerNoticeRepository {
  readonly kind: 'owner-notice-repository';
  post(input: {
    agentId: string;
    text: string;
    taskId?: string;
    extraParts?: readonly unknown[];
  }): Promise<{ conversationId: string }>;
}
