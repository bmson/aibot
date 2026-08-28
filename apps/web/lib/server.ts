// Server-only singletons. Cached on globalThis so Next dev hot-reload doesn't
// leak postgres connection pools on every recompile.
import path from 'node:path';
import {
  addAssistantSkill,
  applyImprovementProposal,
  archiveChatConversation,
  archiveInactiveChats,
  changeChatModel,
  checkReadiness,
  correctOwnerCommitment,
  createChatConversation,
  createMcpConnection,
  decideApproval,
  deleteApprovalPolicy,
  deleteAssistantSkill,
  deleteDocument,
  deleteImportedSource,
  deleteMcpConnection,
  dismissAnomalyRecord,
  dismissImprovementProposal,
  dismissOwnerCommitment,
  downloadArtifact,
  editAssistantSkill,
  exportLongTermMemoryData,
  forgetLongTermMemory,
  getAssistantIdentity,
  getAssistantTimezone,
  getChatConversationView,
  getChatUpdates,
  getDocumentsOverview,
  getImportOverview,
  getMcpConnection,
  getPrimaryConversationId,
  getSettingsOverview,
  getShellStatus,
  handleChatTurn,
  isValidChatCursor,
  listActivity,
  listAnomalies,
  listApprovalInbox,
  listAssistantSkills,
  listChatHistory,
  listCommitmentOverview,
  listGoalsDashboard,
  listImprovementProposals,
  listMcpConnections,
  purgeImportedSource,
  recordOwnerForeground,
  recordOwnerLocationPing,
  recordRecallFeedback,
  registerDeviceToken,
  resolveOwnerCommitment,
  restoreChatConversation,
  reviewImportedSource,
  saveMcpDiscovery,
  setApprovalPolicyEnabled,
  setAssistantSkillDeprecated,
  setMcpConnectionEnabled,
  setRecurringJobEnabled,
  snoozeOwnerCommitment,
  startWorkspaceImport,
  suspendAnomalyRecord,
  updateAssistantSettings,
  updateNotificationPrefs,
  uploadDocument,
  uploadImport,
} from '@assistant/application';
import { loadConfig, repoRoot } from '@assistant/config';
import { ModelRouter } from '@assistant/core/model-router';
import { createDb, type Db } from '@assistant/db';
import { inspectMcpConnection } from '@assistant/tools/mcp';
import {
  GcsWorkspaceStore,
  LocalWorkspaceStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';
import { unstable_cache } from 'next/cache';
import { cache } from 'react';

const globalCache = globalThis as unknown as {
  __assistantDb?: Db;
  __assistantRouter?: ModelRouter;
  __assistantWorkspace?: WorkspaceStore;
  __assistantApplication?: ReturnType<typeof createApplication>;
};

export function getDb(): Db {
  if (!globalCache.__assistantDb) {
    const config = loadConfig();
    globalCache.__assistantDb = createDb(config.DATABASE_URL, {
      max: config.DB_POOL_MAX,
      idleTimeoutSeconds: config.DB_IDLE_TIMEOUT_SECONDS,
      connectTimeoutSeconds: config.DB_CONNECT_TIMEOUT_SECONDS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    });
  }
  return globalCache.__assistantDb;
}

export function getRouter(): ModelRouter {
  globalCache.__assistantRouter ??= new ModelRouter(getDb(), loadConfig().OPENROUTER_API_KEY);
  return globalCache.__assistantRouter;
}

/**
 * The owner's timezone (from the agent row), for rendering local timestamps.
 * cache() dedupes it to one query per request across all server components.
 * Falls back to UTC if the agent can't be read.
 */
export const getAgentTimezone = cache(async (): Promise<string> => {
  return getAssistantTimezone(getDb());
});

/**
 * The assistant's display identity (agent row). The name is seed-owned — it
 * matches the bot's Google-account profile so email From headers agree — and
 * the dashboard displays it wherever the assistant "speaks".
 */
export const getAgentIdentity = cache(
  async (): Promise<{ id: string; name: string; avatarUrl: string | null }> =>
    getAssistantIdentity(getDb()),
);

/** Same workspace identity the agent composition root uses. */
export function getWorkspace(): WorkspaceStore {
  if (!globalCache.__assistantWorkspace) {
    const config = loadConfig();
    globalCache.__assistantWorkspace =
      config.FILES_DRIVER === 'gcs'
        ? new GcsWorkspaceStore(
            config.WORKSPACE_BUCKET,
            `workspace/${config.ASSISTANT_WORKSPACE_ID}`,
          )
        : new LocalWorkspaceStore(path.join(repoRoot, '.workspace'));
  }
  return globalCache.__assistantWorkspace;
}

/**
 * Bound application use-cases for the Next.js transport layer. Pages, route
 * handlers, and server actions call this facade instead of reaching into
 * persistence, model routing, or workspace adapters themselves.
 */
function createApplication() {
  const db = getDb();
  const workspace = getWorkspace();
  const refreshMcpConnection = async (connectionId: string) => {
    const current = await getMcpConnection(db, connectionId);
    if (!current) return { error: 'MCP connection not found.' };
    const discovery = await inspectMcpConnection(current.endpoint, {
      bearerTokenEncrypted: current.bearerTokenEncrypted,
    });
    if (!(await saveMcpDiscovery(db, connectionId, discovery))) {
      return { error: 'MCP connection not found.' };
    }
    return { connectionId, ...discovery };
  };
  return {
    listAnomalies: () => listAnomalies(db),
    dismissAnomaly: (id: string) => dismissAnomalyRecord(db, id),
    suspendAnomaly: (id: string) => suspendAnomalyRecord(db, id),
    listImprovementProposals: () => listImprovementProposals(db),
    applyImprovementProposal: (id: string) => applyImprovementProposal(db, id),
    dismissImprovementProposal: (id: string) => dismissImprovementProposal(db, id),
    listSkills: () => listAssistantSkills(db),
    addSkill: (input: { name: string; preconditions: string; steps: string; gotchas: string }) =>
      addAssistantSkill(db, getRouter(), input),
    editSkill: (
      id: string,
      patch: { name: string; preconditions: string; steps: string; gotchas: string },
    ) => editAssistantSkill(db, getRouter(), id, patch),
    deleteSkill: (id: string) => deleteAssistantSkill(db, id),
    setSkillDeprecated: (id: string, deprecated: boolean) =>
      setAssistantSkillDeprecated(db, id, deprecated),
    listMcpConnections: () => listMcpConnections(db),
    addMcpConnection: async (input: { name: string; endpoint: string; bearerToken?: string }) => {
      const created = await createMcpConnection(db, input);
      if (!created.connectionId) return created;
      return refreshMcpConnection(created.connectionId);
    },
    refreshMcpConnection,
    setMcpConnectionEnabled: async (id: string, enabled: boolean) => {
      if (!(await setMcpConnectionEnabled(db, id, enabled)))
        return { error: 'MCP connection not found.' };
      return enabled ? refreshMcpConnection(id) : { connectionId: id, status: 'disabled' as const };
    },
    deleteMcpConnection: (id: string) => deleteMcpConnection(db, id),
    getSettings: () => getSettingsOverview(db),
    updateSettings: (input: { timezone: string; locale: string; signature: string }) =>
      updateAssistantSettings(db, input),
    updateNotificationPrefs: (input: {
      quietStart: string;
      quietEnd: string;
      ambientDailyCap: string;
    }) => updateNotificationPrefs(db, input),
    setScheduleEnabled: (id: string, enabled: boolean) => setRecurringJobEnabled(db, id, enabled),
    setPolicyEnabled: (id: string, enabled: boolean) => setApprovalPolicyEnabled(db, id, enabled),
    deletePolicy: (id: string) => deleteApprovalPolicy(db, id),
    getDocuments: () => getDocumentsOverview(db),
    deleteDocument: (id: string) => deleteDocument(db, workspace, id),
    uploadDocument: (input: { name: string; title?: string; mime?: string; bytes: Buffer }) =>
      uploadDocument(db, workspace, input),
    downloadArtifact: (path: string) => downloadArtifact(db, workspace, path),
    exportLongTermMemoryData: () => exportLongTermMemoryData(db),
    forgetLongTermMemory: () => forgetLongTermMemory(db, workspace),
    getImports: () => getImportOverview(db, workspace),
    startImport: (path: string, source: string) =>
      startWorkspaceImport(db, workspace, path, source),
    purgeImport: (source: string) => purgeImportedSource(db, source),
    deleteImport: (source: string) => deleteImportedSource(db, workspace, source),
    reviewImport: (source: string, verdict: 'approve' | 'reject') =>
      reviewImportedSource(db, source, verdict),
    uploadImport: (input: {
      fileName: string;
      content: string;
      source?: string;
      voice?: boolean;
      register?: string;
    }) => uploadImport(db, workspace, input),
    getPrimaryConversationId: () => getPrimaryConversationId(db),
    recordOwnerLocationPing: (body: unknown) => recordOwnerLocationPing(db, body),
    registerDeviceToken: (body: unknown) => registerDeviceToken(db, body),
    recordOwnerForeground: () => recordOwnerForeground(db),
    recordRecallFeedback: (messageId: string, verdict: 'helpful' | 'not_helpful') =>
      recordRecallFeedback(db, messageId, verdict),
    listActivity: (input: {
      archived: boolean;
      filter: 'all' | 'needs-you' | 'working' | 'scheduled' | 'completed';
      limit?: number;
    }) => listActivity(db, input),
    listCommitments: () => listCommitmentOverview(db),
    resolveCommitment: (id: string, resolution: string) =>
      resolveOwnerCommitment(db, id, resolution),
    snoozeCommitment: (id: string, until: Date) => snoozeOwnerCommitment(db, id, until),
    dismissCommitment: (id: string) => dismissOwnerCommitment(db, id),
    correctCommitment: (
      id: string,
      patch: { title: string; details?: string; nextAction?: string },
    ) => correctOwnerCommitment(db, id, patch),
    listGoals: (archived: boolean) => listGoalsDashboard(db, archived),
    listApprovals: () => listApprovalInbox(db),
    decideApproval: (approvalId: string, decision: 'approved' | 'denied') =>
      decideApproval(db, approvalId, decision),
    // The layout calls this on every request of every route (force-dynamic),
    // and memory health aggregates the whole knowledge-memory table. A sidebar
    // badge does not need transactional freshness; 30 seconds keeps the scan
    // off the per-navigation path as the table grows.
    getShellStatus: (agentId: string) =>
      unstable_cache(() => getShellStatus(db, agentId), ['shell-status', agentId], {
        revalidate: 30,
      })(),
    createChat: () => createChatConversation(db),
    changeChatModel: (conversationId: string, modelId: string | null) =>
      changeChatModel(db, conversationId, modelId),
    archiveChat: (conversationId: string) => archiveChatConversation(db, conversationId),
    restoreChat: (conversationId: string) => restoreChatConversation(db, conversationId),
    archiveInactiveChats: () => archiveInactiveChats(db),
    listChatHistory: (archived: boolean) => listChatHistory(db, archived),
    getChatConversation: (conversationId: string, input: { taskId?: string; cursor?: string }) =>
      getChatConversationView(db, conversationId, input),
    getChatUpdates: (input: {
      conversationId: string;
      taskId?: string;
      cursor?: string;
      pageSize?: number;
      refreshIds?: string[];
    }) => getChatUpdates(db, input),
    isValidChatCursor,
    handleChatTurn: (request: Request) =>
      handleChatTurn(request, { config: loadConfig(), db, router: getRouter() }),
    checkReadiness: () => checkReadiness(db),
  };
}

export function getApplication(): ReturnType<typeof createApplication> {
  globalCache.__assistantApplication ??= createApplication();
  return globalCache.__assistantApplication;
}
