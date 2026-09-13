import type { Records } from './records.js';

export interface ExecutionMessageCursor {
  createdAt: Date;
  id: string;
}

export interface ExecutionContextRepository {
  readonly kind: 'execution-context-repository';
  getAgent(agentId: string): Promise<Records['agents'] | null>;
  getTask(agentId: string, taskId: string): Promise<Records['tasks'] | null>;
  getGoalStopState(
    agentId: string,
    goalId: string,
  ): Promise<{ status: string; archivedAt: Date | null } | null>;
  /** The latest user/assistant messages from any conversation owned by the agent. */
  seedHistory(input: {
    agentId: string;
    conversationId: string;
    before: Date;
    limit?: number;
  }): Promise<Records['messages'][]>;
  getInboundMessage(input: {
    agentId: string;
    conversationId: string;
    channelMessageId: string;
  }): Promise<Pick<Records['messages'], 'text'> | null>;
  /** Latest message in an owned chat. Outer null means the conversation is not eligible. */
  getLatestOwnerReplyCursor(input: {
    agentId: string;
    conversationId: string;
  }): Promise<{ cursor: ExecutionMessageCursor | null } | null>;
  /** Owner messages after the strict cursor. Non-chat and foreign conversations return none. */
  getOwnerRepliesAfter(input: {
    agentId: string;
    conversationId: string;
    after: { createdAt: Date; id?: string };
    limit?: number;
  }): Promise<Records['messages'][]>;
  noticeIds(
    agentId: string,
    rows: ReadonlyArray<{ id: string; role: string; taskId: string | null; parts: unknown }>,
  ): Promise<Set<string>>;
}
