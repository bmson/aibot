import type { TaskRow } from '@assistant/db';
import type { ExecutionEvidenceRepository } from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { requestedDocumentReadIntent } from '../artifact-intent.js';

/** The latest owner-supplied Google Doc URL in the current user turn, if any. */
function sharedDocumentIntent(window: ModelMessage[]) {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    return requestedDocumentReadIntent(message.content);
  }
  return undefined;
}

/** Avoid repeatedly re-reading the same shared document on every chat turn. */
export async function unreadSharedDocumentIntent(
  evidence: Pick<ExecutionEvidenceRepository, 'hasConversationToolCall'>,
  task: TaskRow,
  window: ModelMessage[],
) {
  if (task.trust !== 'owner') return undefined;
  const intent = sharedDocumentIntent(window);
  if (!intent || !task.conversationId) return intent;
  const alreadyRead = await evidence.hasConversationToolCall({
    agentId: task.agentId,
    conversationId: task.conversationId,
    toolName: intent.toolName,
    documentId: intent.documentId,
  });
  return alreadyRead ? undefined : intent;
}
