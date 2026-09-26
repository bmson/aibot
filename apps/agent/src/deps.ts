import path from 'node:path';
import {
  type Config,
  loadConfig,
  parseFirestoreEmbeddingSpace,
  repoRoot,
  validateAgentPersistenceConfig,
} from '@assistant/config';
import {
  createConfiguredModelProvider,
  type DocumentProcessorConfig,
  findPrimaryConversation,
  getAgent,
  goalAutomationCadence,
  goalAutomationInstruction,
  ModelRouter,
  nextRun,
  postOwnerNotice,
} from '@assistant/core';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import { supersedeContradictedFacts } from '@assistant/core/memory/supersede';
import { evaluateOutOfBandPing } from '@assistant/core/proactive/nudge-policy';
import { createDb, createPostgresExecutionPersistence, type Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  createInstallationStore,
  FirestoreContactLookupRepository,
  FirestoreConversationSearchRepository,
  FirestoreDocumentExtractionRepository,
  FirestoreGoalMutationRepository,
  FirestoreGoalProgressRepository,
  FirestoreGoalReadRepository,
  FirestoreGraphRecallRepository,
  FirestoreImportJobRepository,
  FirestoreMcpConnectionReadRepository,
  FirestoreMissionRepository,
  FirestoreOccasionToolRepository,
  FirestoreOwnerNoticeRepository,
  FirestoreReminderRepository,
  FirestoreScheduleRepository,
  FirestoreSituationToolRepository,
  type FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';
import {
  browserModule,
  composedModuleMetas as collectModuleMetas,
  documentsModule,
  type InstalledModuleSet,
  installModules,
  type ModuleMeta,
  type ModuleServices,
  noopOwnerNotifier,
  type OwnerNotifier,
  type SmsChannelDeps,
  smsModule,
} from '@assistant/modules';
import {
  type DocumentExtractionRepository,
  type EmbeddingSpace,
  type ExecutionPersistence,
  embeddingModelId,
  type GoalToolRepository,
  type ImportJobRepository,
  type ModelRoutingRepository,
  type NudgePolicyRepository,
  type Records,
} from '@assistant/persistence';
import type { BrowserJobLauncher } from '@assistant/tools/browser';
import {
  registerBuiltinTools,
  registerPortableContactLookupTool,
  registerPortableConversationSearchTool,
  registerPortableGoalProgressTool,
  registerPortableGoalTools,
  registerPortableGraphSnapshotTool,
  registerPortableMemoryTools,
  registerPortableOccasionTools,
  registerPortableOwnerNotifyTool,
  registerPortableReadResultTool,
  registerPortableTaskTools,
  registerPortableWebWorkspaceTools,
  registerSituationTools,
  registerSportsTools,
  registerWeatherTool,
} from '@assistant/tools/builtin';
import { ToolDispatcher } from '@assistant/tools/dispatcher';
import { registerMcpTools } from '@assistant/tools/mcp';
import { ToolRegistry } from '@assistant/tools/registry';
import {
  GcsWorkspaceStore,
  LocalWorkspaceStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';
// The installation's composition file, at the repository root. Importing it
// here is what bakes the chosen modules into the built image.
import composition from '../../../assistant.config.js';
import { firestoreMaintenanceReady as checkFirestoreMaintenanceReady } from './firestore-maintenance-ready.js';

/**
 * Process-level dependency graph. Apps compose concrete adapters here while
 * business code consumes only the narrower ports exposed by core and tools.
 */
export interface AgentDeps {
  config: Config;
  db: Db;
  persistence?: ExecutionPersistence;
  firestoreStore?: InstallationStore;
  firestoreTasks?: FirestoreTaskRepository;
  documentExtractionRepository?: DocumentExtractionRepository;
  importJobRepository?: ImportJobRepository;
  router: ModelRouter;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  workspace: WorkspaceStore;
  /** Installed capabilities, for code that asks a module what it produced. */
  modules: InstalledModuleSet;
  /** The modules' owner notifier behind the nudge policy — the phone legs only. */
  outOfBandNotifier: OwnerNotifier;
  browserLauncher?: BrowserJobLauncher;
  documentProcessor?: DocumentProcessorConfig;
}

/** Shared readiness fence for the probe and the Firestore local queue. */
export async function firestoreOwnerReady(deps: AgentDeps): Promise<boolean> {
  if (!deps.firestoreStore) return false;
  const owner = await deps.firestoreStore.doc('agents', deps.config.FIRESTORE_AGENT_ID).get();
  return owner.exists && owner.get('id') === deps.config.FIRESTORE_AGENT_ID;
}

/** Maintenance stays fenced while an imported workspace awaits explicit activation. */
export async function firestoreMaintenanceReady(deps: AgentDeps): Promise<boolean> {
  return checkFirestoreMaintenanceReady(deps.firestoreStore, deps.config.FIRESTORE_AGENT_ID);
}

/** Firestore MCP tools are opt-in outside production until runtime validation matures. */
export function registerFirestoreMcpTools(
  registry: ToolRegistry,
  store: InstallationStore,
  agentId: string,
  environment: NodeJS.ProcessEnv = process.env,
): ToolRegistry {
  if (environment.NODE_ENV === 'production' || environment.FIRESTORE_MCP_TOOLS_ENABLED !== 'true')
    return registry;
  const connections = new FirestoreMcpConnectionReadRepository(store, agentId);
  return registerMcpTools(registry, {
    list: (ownerId) => connections.list(ownerId),
    get: (ownerId, connectionId) => connections.getForTools(ownerId, connectionId),
  });
}

/**
 * The composed modules' plain metadata. Route mounters read this at import
 * time — before any deps exist — because Hono routes register statically while
 * enabled-guards evaluate per request.
 */
export const composedModuleMetas: readonly ModuleMeta[] = collectModuleMetas(composition);

/**
 * The sms channel's narrow deps, from the agent graph. Canaries — the one
 * consumer left in the agent — reach the channel through this; everything
 * else consumes the owner-notifier port.
 */
export function smsDeps(deps: AgentDeps): SmsChannelDeps {
  const persistence = deps.persistence ?? createPostgresExecutionPersistence(deps.db);
  const { smsChannel } = persistence;
  if (!smsChannel) throw new Error('sms: persistence has no SMS channel repository');
  return {
    config: deps.config,
    registry: deps.registry,
    twilio: deps.modules.requireExports(smsModule),
    persistence: { ...persistence, smsChannel },
    owner: () => getAgent(deps.db),
  };
}

/**
 * The owner notifier the platform always has.
 *
 * `OwnerNotifier` is a port that channel MODULES provide, and SMS is the only
 * module that implements it — so without Twilio installed, every notice the
 * platform generates went to `noopOwnerNotifier` and vanished. The dashboard is
 * core platform rather than an optional capability, so it belongs here in the
 * composition root rather than behind a module.
 *
 * Composed with (not substituted for) whatever modules provide: a notice should
 * reach the owner's chat AND their phone when both exist. Each leg is
 * best-effort and independent, so a Twilio outage cannot swallow the dashboard
 * copy, and vice versa.
 */
export function shouldMirrorIntoPrimary(
  sourceConversationId: string | null | undefined,
  primaryConversationId: string | null | undefined,
): boolean {
  return !sourceConversationId || sourceConversationId !== primaryConversationId;
}

export function approvalSummaryNotice(
  approvals: ReadonlyArray<{ purpose?: string; id?: string }>,
): {
  text: string;
  extraParts: readonly unknown[];
} {
  const purpose =
    approvals.find((approval) => approval.purpose?.trim())?.purpose?.trim() ?? 'Continue this task';
  const approvalCount = approvals.length;
  // Naming the approvals is what lets the card stop saying "waiting for
  // review" once they are answered: without them the count is frozen at
  // whatever it was when the notice was written. See hydrateChatApprovals.
  const approvalIds = approvals
    .map((approval) => approval.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return {
    text: [
      `Approval needed to continue: ${purpose}`,
      `${approvalCount} ${approvalCount === 1 ? 'action is' : 'actions are'} waiting for review in Approvals.`,
    ].join('\n'),
    extraParts: [
      {
        type: 'approval-summary',
        purpose,
        approvalCount,
        ...(approvalIds.length > 0 ? { approvalIds } : {}),
      },
    ],
  };
}

function dashboardOwnerNotifier(deps: AgentDeps): OwnerNotifier {
  const post = async (
    text: string,
    taskId?: string,
    sourceConversationId?: string | null,
    extraParts?: readonly unknown[],
  ) => {
    const agent = await getAgent(deps.db);
    const primary = await findPrimaryConversation(deps.db, agent.id);
    // Executor notices are already persisted into their owning conversation.
    // Mirroring one whose owner IS the primary chat creates the exact pair the
    // reader used to see: a structured card followed by a prose restatement.
    if (!shouldMirrorIntoPrimary(sourceConversationId, primary?.id)) return;
    await postOwnerNotice(deps.db, {
      agentId: agent.id,
      text,
      ...(taskId ? { taskId } : {}),
      ...(extraParts?.length ? { extraParts } : {}),
    });
  };
  return {
    notifyOwner: async ({ text, taskId, conversationId }) => {
      await post(text, taskId, conversationId);
    },
    // Approval cards are already posted into the originating conversation by the
    // executor. Mirror one compact, purpose-first summary for an owner who is
    // looking at the primary chat instead — details remain on Approvals.
    notifyApprovals: async (pending) => {
      if (pending.length === 0) return;
      const agent = await getAgent(deps.db);
      const primary = await findPrimaryConversation(deps.db, agent.id);
      const notices = pending.filter((approval) =>
        shouldMirrorIntoPrimary(approval.conversationId, primary?.id),
      );
      if (notices.length === 0) return;
      const summary = approvalSummaryNotice(notices);
      await post(summary.text, notices[0]?.taskId, notices[0]?.conversationId, summary.extraParts);
    },
  };
}

/** Firestore's dashboard sink keeps notices durable without opening SQL. */
function firestoreDashboardOwnerNotifier(deps: AgentDeps): OwnerNotifier {
  if (!deps.firestoreStore)
    throw new Error('Firestore owner notices require an installation store');
  const notices = new FirestoreOwnerNoticeRepository(
    deps.firestoreStore,
    deps.config.FIRESTORE_AGENT_ID,
  );
  return {
    notifyOwner: async ({ text, taskId, conversationId }) => {
      await notices.post({ text, taskId, sourceConversationId: conversationId });
    },
    notifyApprovals: async (pending) => {
      if (pending.length === 0) return;
      const primaryId = await notices.primaryConversationId();
      const toMirror = pending.filter((approval) =>
        shouldMirrorIntoPrimary(approval.conversationId, primaryId),
      );
      if (toMirror.length === 0) return;
      const summary = approvalSummaryNotice(toMirror);
      await notices.post({
        text: summary.text,
        taskId: toMirror[0]?.taskId,
        sourceConversationId: toMirror[0]?.conversationId,
        extraParts: summary.extraParts,
      });
    },
  };
}

/**
 * The nudge-policy gate on the out-of-band legs (SMS/push). Ambient notices
 * consult quiet hours and the daily cap here — one choke point every module
 * notifier passes through, so no producer has to know the others exist. A
 * held notice is recorded in the ping ledger and still posts to the dashboard
 * leg, which is composed separately and never gated. Approvals bypass the
 * policy entirely: the owner is the one waiting on them.
 */
function policyGatedOutOfBand(
  policy: Db | NudgePolicyRepository,
  owner: () => Promise<{ id: string; timezone: string }>,
  inner: OwnerNotifier,
): OwnerNotifier {
  return {
    notifyOwner: async (input) => {
      const decision = await evaluateOutOfBandPing(policy, await owner(), {
        urgency: input.urgency ?? 'interrupt',
      });
      if (!decision.deliver) return;
      await inner.notifyOwner(input);
    },
    notifyApprovals: (pending) => inner.notifyApprovals(pending),
  };
}

/** Fan a notice out to every notifier, so one failing channel cannot silence the rest. */
function composeOwnerNotifiers(notifiers: readonly OwnerNotifier[]): OwnerNotifier {
  const each = async (run: (notifier: OwnerNotifier) => Promise<void>) => {
    for (const notifier of notifiers) {
      await run(notifier).catch((err) => console.error('owner notification failed', err));
    }
  };
  return {
    notifyOwner: (input) => each((notifier) => notifier.notifyOwner(input)),
    notifyApprovals: (approvals) => each((notifier) => notifier.notifyApprovals(approvals)),
  };
}

/** The invocation-time services module hooks receive. */
export function agentServices(deps: AgentDeps): ModuleServices {
  return {
    config: deps.config,
    db: deps.db,
    router: deps.router,
    registry: deps.registry,
    dispatcher: deps.dispatcher,
    workspace: deps.workspace,
    ownerNotifier: composeOwnerNotifiers([
      deps.config.PERSISTENCE_DRIVER === 'firestore'
        ? firestoreDashboardOwnerNotifier(deps)
        : dashboardOwnerNotifier(deps),
      deps.outOfBandNotifier,
    ]),
    emailObservers: deps.modules.emailObservers,
    persistence: deps.persistence ?? createPostgresExecutionPersistence(deps.db),
  };
}

let cached: AgentDeps | undefined;

/** A type-compatible tripwire for legacy paths that have no Firestore adapter yet. */
function unavailableSqlDb(): Db {
  return new Proxy({} as Db, {
    get(_target, property) {
      throw new Error(
        `PostgreSQL access is unavailable in Firestore agent mode: ${String(property)}`,
      );
    },
  });
}

/** Reject a model-role change before it can mix incompatible memory vectors. */
export function pinnedMemoryEmbed(
  space: EmbeddingSpace,
  routing: Pick<ModelRoutingRepository, 'role'>,
  embed: (texts: string[]) => Promise<number[][]>,
): (texts: string[]) => Promise<number[][]> {
  return async (texts) => {
    const selected = await routing.role('embed');
    const expected = embeddingModelId(space);
    if (selected?.primaryModel !== expected) {
      throw new Error(`Firestore memory embedding role must use ${expected}`);
    }
    return embed(texts);
  };
}

/** The recurring automation a goal created by goals.create runs on, as the PostgreSQL goal sync builds it. */
function goalAutomation(goal: Records['goals']) {
  const cadence = goalAutomationCadence(goal);
  return {
    cron: cadence.cron,
    instruction: goalAutomationInstruction(goal),
    nextRunAt: (timezone: string) => nextRun(cadence.cron, timezone),
  };
}

/** goals.list and goals.create on the Firestore goal repositories. */
function firestoreGoalTools(store: InstallationStore, agentId: string): GoalToolRepository {
  const reads = new FirestoreGoalReadRepository(store, agentId);
  const mutations = new FirestoreGoalMutationRepository(store, agentId);
  return {
    listStanding: (ownerId) => reads.listStanding(ownerId),
    create: (input) => {
      if (input.agentId !== agentId)
        throw new Error('Goal creation is outside the configured Firestore agent');
      return mutations.createFromTool(
        {
          title: input.title,
          description: input.description,
          priority: input.priority,
          targetDate: input.targetDate,
          progress: '',
          nextAction: '',
          mirrorToPrimary: false,
          taintedOrigin: input.taintedOrigin,
        },
        goalAutomation,
      );
    },
  };
}

function buildFirestoreDeps(config: Config): AgentDeps {
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  return composeFirestoreAgent(config);
}

/**
 * The Firestore composition itself, without the runtime policy that narrows
 * which modules may be enabled. `buildDeps` always validates first. This is
 * exported so a test can compose every production module and prove that
 * construction opens no SQL client.
 */
export function composeFirestoreAgent(config: Config): AgentDeps {
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  const embeddingSpace = parseFirestoreEmbeddingSpace(config.FIRESTORE_EMBEDDING_SPACE);
  const persistence = createFirestoreExecutionPersistence(
    store,
    config.FIRESTORE_AGENT_ID,
    embeddingSpace,
  );
  const documentExtractionRepository = new FirestoreDocumentExtractionRepository(
    store,
    config.FIRESTORE_AGENT_ID,
    embeddingSpace,
  );
  const importJobRepository = new FirestoreImportJobRepository(
    store,
    config.FIRESTORE_AGENT_ID,
    embeddingSpace,
  );
  const db = unavailableSqlDb();
  const router = new ModelRouter(
    persistence.modelRouting,
    config.OPENROUTER_API_KEY,
    config.LLM_AUDIT_CAPTURE,
    createConfiguredModelProvider(config),
  );
  const workspacePrefix = `workspace/${config.ASSISTANT_WORKSPACE_ID}`;
  const workspaceRoot = path.join(repoRoot, '.workspace');
  const workspace: WorkspaceStore =
    config.FILES_DRIVER === 'gcs'
      ? new GcsWorkspaceStore(config.WORKSPACE_BUCKET, workspacePrefix)
      : new LocalWorkspaceStore(workspaceRoot);
  const ownerTimezone = async (agentId: string): Promise<string> => {
    if (agentId !== config.FIRESTORE_AGENT_ID)
      throw new Error('Owner is outside the configured Firestore agent');
    const owner = await store.doc('agents', agentId).get();
    const timezone = owner.exists ? owner.get('timezone') : null;
    if (typeof timezone !== 'string' || !timezone)
      throw new Error('Firestore owner timezone is unavailable');
    return timezone;
  };
  // Memory, scheduling, goals, missions, owner notices, and keyless lookups use
  // portable repositories.
  // MCP tools can use their Firestore adapter, but remain explicitly opt-in here.
  const notices = new FirestoreOwnerNoticeRepository(store, config.FIRESTORE_AGENT_ID);
  // Late-bound like the PostgreSQL composition: owner.notify registers before
  // the modules that supply the phone legs are installed.
  let outOfBandNotifier: OwnerNotifier = noopOwnerNotifier;
  const registry = registerFirestoreMcpTools(
    registerPortableOwnerNotifyTool(
      registerPortableGoalProgressTool(
        registerPortableTaskTools(
          registerPortableMemoryTools(
            registerPortableWebWorkspaceTools(
              registerSportsTools(
                registerWeatherTool(new ToolRegistry(), { ownerContext: persistence.ownerContext }),
                { timezone: ownerTimezone },
              ),
              { workspace },
            ),
            {
              memory: persistence.memory,
              embed: pinnedMemoryEmbed(embeddingSpace, persistence.modelRouting, (texts) =>
                router.embed(texts),
              ),
              supersede: (input) =>
                supersedeContradictedFacts(
                  {
                    memory: persistence.memorySupersede,
                    router,
                    onRetired: () =>
                      compileOwnerCard(persistence.ownerCardCompilation, input.agentId),
                  },
                  input,
                ),
            },
          ),
          { tasks: persistence.tasks },
        ),
        new FirestoreGoalProgressRepository(store, config.FIRESTORE_AGENT_ID),
      ),
      {
        post: (input) => {
          if (input.agentId !== config.FIRESTORE_AGENT_ID)
            throw new Error('Owner notice is outside the configured Firestore agent');
          return notices.postToolNotice(input);
        },
        notifyOwner: (input) => outOfBandNotifier.notifyOwner(input),
      },
    ),
    store,
    config.FIRESTORE_AGENT_ID,
  );
  registerPortableGoalTools(registry, {
    goals: firestoreGoalTools(store, config.FIRESTORE_AGENT_ID),
    missions: new FirestoreMissionRepository(store, config.FIRESTORE_AGENT_ID),
  });
  // Built-in record tools (graph snapshot, stored results, occasions,
  // contacts, conversation search, situation packs) use their Firestore
  // repositories. Vector reads use the pinned embedding space.
  const recordEmbed = pinnedMemoryEmbed(embeddingSpace, persistence.modelRouting, (texts) =>
    router.embed(texts),
  );
  registerPortableGraphSnapshotTool(registry, {
    embed: recordEmbed,
    graph: new FirestoreGraphRecallRepository(store, embeddingSpace),
  });
  registerPortableReadResultTool(registry, { toolExecution: persistence.toolExecution });
  registerPortableOccasionTools(
    registry,
    new FirestoreOccasionToolRepository(store, config.FIRESTORE_AGENT_ID),
  );
  registerPortableContactLookupTool(
    registry,
    new FirestoreContactLookupRepository(store, config.FIRESTORE_AGENT_ID),
  );
  registerPortableConversationSearchTool(registry, {
    embed: recordEmbed,
    conversations: new FirestoreConversationSearchRepository(store, embeddingSpace),
  });
  registerSituationTools(
    registry,
    new FirestoreSituationToolRepository(store, config.FIRESTORE_AGENT_ID),
  );
  const modules = installModules(composition.modules, {
    config,
    db,
    registry,
    repoRoot,
    router,
    workspace,
    workspacePrefix,
    workspaceRoot,
    persistence,
    portableReminders: {
      schedules: new FirestoreScheduleRepository(store),
      reminders: new FirestoreReminderRepository(store),
      getTimezone: ownerTimezone,
    },
  });
  const nudgePolicy = persistence.nudgePolicy;
  if (!nudgePolicy) throw new Error('Firestore persistence has no nudge policy');
  outOfBandNotifier = policyGatedOutOfBand(
    nudgePolicy,
    async () => ({
      id: config.FIRESTORE_AGENT_ID,
      timezone: await ownerTimezone(config.FIRESTORE_AGENT_ID),
    }),
    modules.ownerNotifier,
  );
  return {
    config,
    db,
    firestoreStore: store,
    firestoreTasks: persistence.tasks,
    documentExtractionRepository,
    importJobRepository,
    persistence,
    router,
    registry,
    dispatcher: new ToolDispatcher(
      db,
      registry,
      persistence.toolExecution,
      persistence.costs,
      persistence.approvals,
      persistence.approvalPolicies,
    ),
    workspace,
    modules,
    outOfBandNotifier,
  };
}

export function buildDeps(): AgentDeps {
  if (cached) return cached;

  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    cached = buildFirestoreDeps(config);
    return cached;
  }
  const db = createDb(config.DATABASE_URL, {
    max: config.DB_POOL_MAX,
    idleTimeoutSeconds: config.DB_IDLE_TIMEOUT_SECONDS,
    connectTimeoutSeconds: config.DB_CONNECT_TIMEOUT_SECONDS,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    sourceWritesFenced: config.POSTGRES_SOURCE_WRITES_FENCED,
  });
  const persistence = createPostgresExecutionPersistence(db);
  const router = new ModelRouter(
    persistence.modelRouting,
    config.OPENROUTER_API_KEY,
    config.LLM_AUDIT_CAPTURE,
    createConfiguredModelProvider(config),
  );
  const workspacePrefix = `workspace/${config.ASSISTANT_WORKSPACE_ID}`;
  const workspaceRoot = path.join(repoRoot, '.workspace');
  const workspace: WorkspaceStore =
    config.FILES_DRIVER === 'gcs'
      ? new GcsWorkspaceStore(config.WORKSPACE_BUCKET, workspacePrefix)
      : new LocalWorkspaceStore(workspaceRoot);

  // The policy-gated out-of-band notifier is a late binding: built-in tools
  // register BEFORE modules are installed, so the owner.notify `ping` leg
  // reaches the (by then assigned) gated aggregate through this closure.
  // Until then it no-ops — a ping during boot has nowhere to go anyway.
  let outOfBandNotifier: OwnerNotifier = noopOwnerNotifier;

  // Built-ins are the base platform: memory, goals, approvals, missions, and
  // workspace tools. Optional provider/worker modules are installed below, and
  // each registers its own tools — the composition root names none of them.
  const registry = registerMcpTools(
    registerBuiltinTools(new ToolRegistry(), {
      tasks: persistence.tasks,
      memory: persistence.memory,
      embed: (texts) => router.embed(texts),
      workspace,
      notifyOwner: (input) => outOfBandNotifier.notifyOwner(input),
      supersede: (input) =>
        supersedeContradictedFacts(
          {
            memory: persistence.memorySupersede,
            router,
            onRetired: () => compileOwnerCard(persistence.ownerCardCompilation, input.agentId),
          },
          input,
        ),
    }),
  );
  const modules = installModules(composition.modules, {
    config,
    db,
    registry,
    repoRoot,
    router,
    workspace,
    workspacePrefix,
    workspaceRoot,
    persistence,
  });
  outOfBandNotifier = policyGatedOutOfBand(db, () => getAgent(db), modules.ownerNotifier);

  const browserLauncher = modules.exportsOf(browserModule);
  const documentProcessor = modules.exportsOf(documentsModule);
  cached = {
    config,
    db,
    router,
    registry,
    persistence,
    dispatcher: new ToolDispatcher(
      db,
      registry,
      persistence.toolExecution,
      persistence.costs,
      persistence.approvals,
      persistence.approvalPolicies,
    ),
    workspace,
    modules,
    outOfBandNotifier,
    ...(browserLauncher ? { browserLauncher } : {}),
    ...(documentProcessor ? { documentProcessor } : {}),
  };
  return cached;
}
