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
  deleteReminder,
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
  getDocument,
  getDocumentsOverview,
  getImportOverview,
  getMcpConnection,
  getPrimaryConversationId,
  getProactiveHealth,
  getSettingsOverview,
  getShellStatus,
  handleChatTurn,
  hideChatMessage,
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
  unhideChatMessage,
  updateAssistantSettings,
  updateNotificationPrefs,
  uploadDocument,
  uploadImport,
  waitForChatUpdates,
} from '@assistant/application';
import type { GoalInput } from '@assistant/application/goals';
import {
  type ProfileMemoryCommandPersistence,
  profileMemoryCommands,
} from '@assistant/application/profile';
import {
  loadConfig,
  parseFirestoreEmbeddingSpace,
  repoRoot,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import { encodeMessageCursor } from '@assistant/core/chat';
import { encryptMcpBearerToken } from '@assistant/core/mcp-secrets';
import { createConfiguredModelProvider, ModelRouter } from '@assistant/core/model-router';
import {
  goalAutomationCadence,
  goalAutomationInstruction,
  nextRun,
} from '@assistant/core/workflow/schedules';
import {
  createDb,
  createPostgresCardRefreshRepository,
  createPostgresGeneratedCardRepository,
  type Db,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  createFirestoreSettingsPersistence,
  createInstallationStore,
  FirestoreApplicationChatPersistence,
  FirestoreGoalMutationRepository,
  FirestoreMcpConnectionMutationRepository,
  FirestoreShellStatusRepository,
  FirestoreSkillMutationRepository,
} from '@assistant/firestore';
import { embeddingModelId, validateEmbedding } from '@assistant/persistence';
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
  __assistantFirestoreStore?: ReturnType<typeof createInstallationStore>;
};

/** Keep credential encryption behind the server-only application boundary. */
export function encryptMcpConnectionBearerToken(token: string): string {
  return encryptMcpBearerToken(token);
}

/** Reuse one Firestore client across requests in a web process. */
export function getFirestoreInstallationStore() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    throw new Error('Firestore installation store requires Firestore persistence');
  globalCache.__assistantFirestoreStore ??= createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  return globalCache.__assistantFirestoreStore;
}

/** Run guarded discovery through the shared SSRF-checked MCP transport. */
export async function discoverFirestoreMcpConnection(connectionId: string) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    return { error: 'Firestore MCP discovery requires Firestore persistence.' };
  const repository = new FirestoreMcpConnectionMutationRepository(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
  try {
    const connection = await repository.beginDiscovery(connectionId);
    if (!connection) return { error: 'MCP connection not found or disabled.' };
    const result = await inspectMcpConnection(connection.endpoint, {
      bearerTokenEncrypted: connection.bearerTokenEncrypted,
    });
    if (
      !(await repository.saveDiscovery(connectionId, connection.attemptId, {
        status: result.status,
        serverName: result.serverName ?? null,
        serverVersion: result.serverVersion ?? null,
        instructions: result.instructions ?? null,
        tools: result.tools,
        error: result.error ?? null,
      }))
    )
      return { error: 'MCP connection changed while discovery was running.' };
    return {
      connectionId,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'MCP discovery could not be completed.',
    };
  }
}

export function getFirestoreGoalScheduleUpdate(id: string, input: GoalInput) {
  return {
    cron: goalAutomationCadence(input).cron,
    instruction: goalAutomationInstruction({
      id,
      title: input.title,
      description: input.description,
      progress: input.progress,
      nextAction: input.nextAction,
      targetDate: input.targetDate,
    }),
  };
}

function goalWorkAutomation(goal: {
  id: string;
  title: string;
  description: string;
  priority: number;
  progress: string;
  nextAction: string;
  targetDate: Date | null;
}) {
  const cadence = goalAutomationCadence(goal);
  return {
    cron: cadence.cron,
    instruction: goalAutomationInstruction(goal),
    nextRunAt: (timezone: string) => nextRun(cadence.cron, timezone),
  };
}

function goalWorkResult(work: { conversationId: string; taskId: string; taskCreatedAt: Date }) {
  return {
    conversationId: work.conversationId,
    taskId: work.taskId,
    messageCursor: encodeMessageCursor({ createdAt: work.taskCreatedAt, id: work.taskId }),
  };
}

export async function createFirestoreGoalWithWork(input: GoalInput) {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const repository = new FirestoreGoalMutationRepository(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
  return goalWorkResult(await repository.createWithWork(input, goalWorkAutomation));
}

export async function startFirestoreGoalWork(id: string) {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const repository = new FirestoreGoalMutationRepository(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
  return goalWorkResult(await repository.startWork(id, goalWorkAutomation));
}

export function getDb(): Db {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    throw new Error('PostgreSQL-backed web surface is unavailable in Firestore mode');
  }
  if (!globalCache.__assistantDb) {
    const config = loadConfig();
    globalCache.__assistantDb = createDb(config.DATABASE_URL, {
      max: config.DB_POOL_MAX,
      idleTimeoutSeconds: config.DB_IDLE_TIMEOUT_SECONDS,
      connectTimeoutSeconds: config.DB_CONNECT_TIMEOUT_SECONDS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      sourceWritesFenced: config.POSTGRES_SOURCE_WRITES_FENCED,
    });
  }
  return globalCache.__assistantDb;
}

export function getGeneratedCards() {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    return getFirestoreChatApplication().getGeneratedCards();
  }
  return createPostgresGeneratedCardRepository(getDb());
}

export function getCardRefresh() {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    return getFirestoreChatApplication().getCardRefresh();
  }
  return createPostgresCardRefreshRepository(getDb());
}

export function getRouter(): ModelRouter {
  const config = loadConfig();
  globalCache.__assistantRouter ??= new ModelRouter(
    getDb(),
    config.OPENROUTER_API_KEY,
    config.LLM_AUDIT_CAPTURE,
    createConfiguredModelProvider(config),
  );
  return globalCache.__assistantRouter;
}

/**
 * The owner's timezone (from the agent row), for rendering local timestamps.
 * cache() dedupes it to one query per request across all server components.
 * Falls back to UTC if the agent can't be read.
 */
export const getAgentTimezone = cache(async (): Promise<string> => {
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    try {
      return await getFirestoreChatApplication().getAgentTimezone();
    } catch {
      return 'UTC';
    }
  }
  return getAssistantTimezone(getDb());
});

/**
 * The assistant's display identity (agent row). The name is seed-owned — it
 * matches the bot's Google-account profile so email From headers agree — and
 * the dashboard displays it wherever the assistant "speaks".
 */
export const getAgentIdentity = cache(
  async (): Promise<{ id: string; name: string; avatarUrl: string | null }> => {
    if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
      return getFirestoreChatApplication().getAgentIdentity();
    }
    return getAssistantIdentity(getDb());
  },
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
function createApplication(options: { profileMemory?: ProfileMemoryCommandPersistence } = {}) {
  const db = getDb();
  const memoryCommands = profileMemoryCommands(options.profileMemory ?? db, {
    embed: (texts) => getRouter().embed(texts),
  });
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
    ...memoryCommands,
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
    getProactiveHealth: () => getProactiveHealth(db),
    updateSettings: (input: { timezone: string; locale: string; signature: string }) =>
      updateAssistantSettings(db, input),
    updateNotificationPrefs: (input: {
      quietStart: string;
      quietEnd: string;
      ambientDailyCap: string;
    }) => updateNotificationPrefs(db, input),
    setScheduleEnabled: (id: string, enabled: boolean) => setRecurringJobEnabled(db, id, enabled),
    deleteReminder: (id: string) => deleteReminder(db, id),
    setPolicyEnabled: (id: string, enabled: boolean) => setApprovalPolicyEnabled(db, id, enabled),
    deletePolicy: (id: string) => deleteApprovalPolicy(db, id),
    getDocuments: () => getDocumentsOverview(db),
    getDocument: (id: string) => getDocument(db, id),
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
    hideChatMessage: (conversationId: string, messageId: string) =>
      hideChatMessage(db, conversationId, messageId),
    unhideChatMessage: (conversationId: string, messageId: string) =>
      unhideChatMessage(db, conversationId, messageId),
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
      /** Hold the poll open for up to this long rather than answering "nothing yet". */
      waitMs?: number;
      /** The request's own signal, so a client that hangs up ends the hold. */
      signal?: AbortSignal;
    }) => waitForChatUpdates(db, input),
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

/** Portable chat operations exposed to web and mobile transports in Firestore mode. */
function createFirestoreChatApplication() {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = getFirestoreInstallationStore();
  const persistence = createFirestoreExecutionPersistence(
    store,
    config.FIRESTORE_AGENT_ID,
    parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE),
  );
  const embeddingSpace = parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE);
  const chat = new FirestoreApplicationChatPersistence(store, config.FIRESTORE_AGENT_ID);
  const shellStatus = new FirestoreShellStatusRepository(store, config.FIRESTORE_AGENT_ID);
  const router = new ModelRouter(
    persistence.modelRouting,
    config.OPENROUTER_API_KEY,
    config.LLM_AUDIT_CAPTURE,
    createConfiguredModelProvider(config),
  );
  const chatReads = { chat, generatedCards: persistence.generatedCards };
  const settings = createFirestoreSettingsPersistence(store, config.FIRESTORE_AGENT_ID);
  const skillMutations = new FirestoreSkillMutationRepository(store, embeddingSpace);
  const skillEmbeddingText = (input: {
    name: string;
    preconditions: string;
    steps: string;
    gotchas: string;
  }) =>
    [
      input.name,
      input.preconditions && `When: ${input.preconditions}`,
      input.steps && `Steps: ${input.steps}`,
      input.gotchas && `Gotchas: ${input.gotchas}`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000);
  const embedSkillText = async (text: string): Promise<number[]> => {
    const [vector] = await router.embed([text], {
      expectedModelId: embeddingModelId(embeddingSpace),
    });
    const result = vector ?? [];
    validateEmbedding(embeddingSpace, result);
    return result;
  };
  const embedSkill = async (input: {
    name: string;
    preconditions: string;
    steps: string;
    gotchas: string;
  }) => {
    return embedSkillText(skillEmbeddingText(input));
  };
  return {
    embedSkillText,
    getWorkspaceSettings: () => getSettingsOverview(settings),
    addSkill: async (input: {
      name: string;
      preconditions: string;
      steps: string;
      gotchas: string;
    }) => {
      const normalized = {
        name: input.name.trim().slice(0, 200),
        preconditions: input.preconditions.trim(),
        steps: input.steps.trim(),
        gotchas: input.gotchas.trim(),
      };
      if (!normalized.name) return { error: 'Give the skill a name.' };
      if (!normalized.steps) return { error: 'Describe the steps.' };
      try {
        const embedding = await embedSkill(normalized);
        await skillMutations.saveOwner(config.FIRESTORE_AGENT_ID, normalized, embedding);
        return {};
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
      }
    },
    editSkill: async (
      id: string,
      input: { name: string; preconditions: string; steps: string; gotchas: string },
    ) => {
      const normalized = {
        name: input.name.trim().slice(0, 200),
        preconditions: input.preconditions.trim(),
        steps: input.steps.trim(),
        gotchas: input.gotchas.trim(),
      };
      if (!normalized.name || !normalized.steps) return { error: 'Name and steps are required.' };
      try {
        const embedding = await embedSkill(normalized);
        await skillMutations.editOwner(config.FIRESTORE_AGENT_ID, id, normalized, embedding);
        return {};
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
      }
    },
    deleteSkill: (id: string) => skillMutations.delete(config.FIRESTORE_AGENT_ID, id),
    setSkillDeprecated: (id: string, deprecated: boolean) =>
      skillMutations.setDeprecated(config.FIRESTORE_AGENT_ID, id, deprecated),
    getGeneratedCards: () => persistence.generatedCards,
    getCardRefresh: () => persistence.cardRefresh,
    getAgentIdentity: async () => {
      const agent = await chat.resolveAgent();
      return { id: agent.id, name: agent.name || 'Assistant', avatarUrl: agent.avatarUrl ?? null };
    },
    getAgentTimezone: async () => (await chat.resolveAgent()).timezone || 'UTC',
    getShellStatus: (agentId: string) =>
      unstable_cache(
        () => getShellStatus(shellStatus, agentId),
        ['firestore-shell-status', config.GCP_PROJECT, config.ASSISTANT_WORKSPACE_ID, agentId],
        { revalidate: 30 },
      )(),
    getPrimaryConversationId: () => getPrimaryConversationId(chat),
    createChat: () => createChatConversation(chat),
    changeChatModel: (conversationId: string, modelId: string | null) =>
      changeChatModel(chat, conversationId, modelId),
    archiveChat: (conversationId: string) => archiveChatConversation(chat, conversationId),
    restoreChat: (conversationId: string) => restoreChatConversation(chat, conversationId),
    hideChatMessage: (conversationId: string, messageId: string) =>
      hideChatMessage(chat, conversationId, messageId),
    unhideChatMessage: (conversationId: string, messageId: string) =>
      unhideChatMessage(chat, conversationId, messageId),
    archiveInactiveChats: () => archiveInactiveChats(chat),
    listChatHistory: (archived: boolean) => listChatHistory(chat, archived),
    getChatConversation: (conversationId: string, input: { taskId?: string; cursor?: string }) =>
      getChatConversationView(chatReads, conversationId, input),
    handleChatTurn: (request: Request) =>
      handleChatTurn(request, { config, router, chat, persistence }),
    getChatUpdates: (input: Parameters<typeof waitForChatUpdates>[1]) =>
      waitForChatUpdates(chatReads, input),
    isValidChatCursor,
  };
}

const firestoreChatCache = globalThis as unknown as {
  __assistantFirestoreChatApplication?: ReturnType<typeof createFirestoreChatApplication>;
};

function getFirestoreChatApplication() {
  firestoreChatCache.__assistantFirestoreChatApplication ??= createFirestoreChatApplication();
  return firestoreChatCache.__assistantFirestoreChatApplication;
}

export function embedFirestoreSkillText(text: string): Promise<number[]> {
  return getFirestoreChatApplication().embedSkillText(text);
}

export function getChatApplication() {
  return loadConfig().PERSISTENCE_DRIVER === 'firestore'
    ? getFirestoreChatApplication()
    : getApplication();
}

/** The mobile workspace settings section, backed by the configured owner in either driver. */
export function getWorkspaceSettings() {
  return loadConfig().PERSISTENCE_DRIVER === 'firestore'
    ? getFirestoreChatApplication().getWorkspaceSettings()
    : getApplication().getSettings();
}
