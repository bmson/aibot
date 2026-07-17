import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  interval,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ── Identity ─────────────────────────────────────────────────────────────────

/** The assistant itself. One row today; agent_id everywhere so multi-agent later is data, not migration. */
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  calendarId: text('calendar_id'),
  phoneE164: text('phone_e164'),
  avatarUrl: text('avatar_url'),
  signature: text('signature').notNull().default(''),
  timezone: text('timezone').notNull().default('Atlantic/Reykjavik'),
  locale: text('locale').notNull().default('en'),
  /** GCS prefix for this agent's Workspace (browser profile, downloads, documents, artifacts). */
  workspacePrefix: text('workspace_prefix').notNull(),
  browserProfilePath: text('browser_profile_path'),
  /** Secret Manager secret NAMES (never raw secrets): { googleRefreshToken, twilioFrom, ... } */
  credentialRefs: jsonb('credential_refs').notNull().default({}),
  ...timestamps,
});

// ── Goals & long-horizon work ────────────────────────────────────────────────

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('active'),
    priority: smallint('priority').notNull().default(3),
    progress: text('progress').notNull().default(''),
    nextAction: text('next_action').notNull().default(''),
    targetDate: timestamp('target_date', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('goals_status_check', sql`${t.status} IN ('active','paused','done','abandoned')`),
    index('goals_agent_status_idx').on(t.agentId, t.status),
  ],
);

// ── Conversations & messages ─────────────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    channel: text('channel').notNull(),
    title: text('title').notNull().default(''),
    trust: text('trust').notNull().default('unknown'),
    /** Per-conversation model override for the chat switcher (models.id), null = role default. */
    modelOverride: text('model_override'),
    metadata: jsonb('metadata').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('conversations_channel_check', sql`${t.channel} IN ('chat','sms','email')`),
    check('conversations_trust_check', sql`${t.trust} IN ('owner','known','unknown','assistant')`),
    index('conversations_agent_idx').on(t.agentId, t.updatedAt),
  ],
);

/** Maps external thread identifiers (Gmail threadId, SMS peer E.164, web session) to conversations. */
export const channelBindings = pgTable(
  'channel_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    ...timestamps,
  },
  (t) => [
    check('channel_bindings_channel_check', sql`${t.channel} IN ('chat','sms','email')`),
    uniqueIndex('channel_bindings_channel_external_idx').on(t.channel, t.externalId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    role: text('role').notNull(),
    /** AI SDK UIMessage parts. */
    parts: jsonb('parts').notNull().default([]),
    /** Denormalized plain text (search, previews, embedding source). */
    text: text('text').notNull().default(''),
    origin: text('origin').notNull(),
    /** Gmail message id / Twilio MessageSid — idempotency for inbound events. */
    channelMessageId: text('channel_message_id'),
    /** Populated async for semantic search over conversations. */
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('messages_role_check', sql`${t.role} IN ('user','assistant','system','tool')`),
    check(
      'messages_origin_check',
      sql`${t.origin} IN ('owner','known_contact','unknown','web','assistant','system')`,
    ),
    uniqueIndex('messages_channel_message_id_idx')
      .on(t.channelMessageId)
      .where(sql`${t.channelMessageId} IS NOT NULL`),
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    index('messages_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

// ── Workflows (tasks) ────────────────────────────────────────────────────────

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    goalId: uuid('goal_id').references(() => goals.id),
    /** Normalized InboundEvent that triggered this workflow. */
    trigger: jsonb('trigger').notNull().default({}),
    /** Idempotency for event → task creation (Gmail historyId+msgId, Twilio SID, ...). */
    externalEventId: text('external_event_id'),
    /** Planner output (PlanSchema) — persisted before execution. */
    plan: jsonb('plan'),
    /**
     * Authoritative checkpoint:
     * { phase, completedToolCallIds[], pendingApprovalId?, plannerState, scratchpad, contextWindow }
     * contextWindow = compacted working context; full tool results live in tool_calls.
     */
    state: jsonb('state').notNull().default({}),
    /** Mission-facing, dashboard-rendered. */
    progress: text('progress').notNull().default(''),
    progressPercent: smallint('progress_percent'),
    nextAction: text('next_action').notNull().default(''),
    deadline: timestamp('deadline', { withTimezone: true }),
    reflectEvery: interval('reflect_every'),
    lastReflectedAt: timestamp('last_reflected_at', { withTimezone: true }),
    trust: text('trust').notNull().default('unknown'),
    runAfter: timestamp('run_after', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    attempt: integer('attempt').notNull().default(0),
    maxSteps: integer('max_steps').notNull().default(12),
    budgetUsdLimit: numeric('budget_usd_limit', { precision: 8, scale: 4 })
      .notNull()
      .default('0.25'),
    spentUsd: numeric('spent_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id),
    ...timestamps,
  },
  (t) => [
    check(
      'tasks_type_check',
      sql`${t.type} IN ('chat_turn','sms_turn','email_triage','scheduled','mission','browser_job','adhoc')`,
    ),
    check(
      'tasks_status_check',
      sql`${t.status} IN ('pending','running','waiting_approval','waiting_event','sleeping','waiting_budget','done','failed','needs_attention','cancelled')`,
    ),
    check('tasks_trust_check', sql`${t.trust} IN ('owner','known','unknown','assistant')`),
    check(
      'tasks_progress_percent_check',
      sql`${t.progressPercent} IS NULL OR (${t.progressPercent} >= 0 AND ${t.progressPercent} <= 100)`,
    ),
    uniqueIndex('tasks_external_event_id_idx')
      .on(t.externalEventId)
      .where(sql`${t.externalEventId} IS NOT NULL`),
    index('tasks_status_run_after_idx').on(t.status, t.runAfter),
    index('tasks_agent_status_idx').on(t.agentId, t.status, t.updatedAt),
    index('tasks_parent_idx').on(t.parentTaskId),
  ],
);

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    step: integer('step').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').notNull().default({}),
    risk: text('risk').notNull(),
    status: text('status').notNull().default('proposed'),
    idempotencyKey: text('idempotency_key'),
    result: jsonb('result'),
    error: text('error'),
    approvalId: uuid('approval_id').references((): AnyPgColumn => approvals.id),
    /**
     * Decision provenance:
     * { riskTier, reason, policyId?, policyVersion?, plannerVersion, promptVersion, model }
     */
    decision: jsonb('decision').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tool_calls_risk_check', sql`${t.risk} IN ('autonomous','approval','forbidden')`),
    check(
      'tool_calls_status_check',
      sql`${t.status} IN ('proposed','awaiting_approval','approved','denied','executing','succeeded','failed')`,
    ),
    uniqueIndex('tool_calls_idempotency_key_idx')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('tool_calls_task_idx').on(t.taskId, t.step),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    toolCallId: uuid('tool_call_id')
      .notNull()
      .references(() => toolCalls.id),
    /** Short human code (A7) — unique among *pending* approvals, for SMS replies. */
    shortCode: text('short_code').notNull(),
    summary: text('summary').notNull(),
    /** Exact args snapshot shown to the owner. */
    payload: jsonb('payload').notNull().default({}),
    /** Edited args from edit-then-approve; used at execution instead of payload. */
    resolutionPayload: jsonb('resolution_payload'),
    status: text('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedVia: text('resolved_via'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    notifiedChannels: text('notified_channels').array().notNull().default([]),
    /** Set when resolved as Always/Never — the policy row that resolution created. */
    createdPolicyId: uuid('created_policy_id').references((): AnyPgColumn => approvalPolicies.id),
  },
  (t) => [
    check('approvals_status_check', sql`${t.status} IN ('pending','approved','denied','expired')`),
    check(
      'approvals_resolved_via_check',
      sql`${t.resolvedVia} IS NULL OR ${t.resolvedVia} IN ('web','sms')`,
    ),
    uniqueIndex('approvals_pending_short_code_idx')
      .on(t.shortCode)
      .where(sql`${t.status} = 'pending'`),
    index('approvals_status_idx').on(t.status, t.expiresAt),
  ],
);

/**
 * User-authored autonomy rules created from the approval dialog (Always/Never) or /settings.
 * Constrained per-tool templates — never free-form predicates. Consulted by the risk gate
 * after the forbidden check, before dynamic risk functions.
 */
export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    toolName: text('tool_name').notNull(),
    /** e.g. 'sms.reply_to_owner', 'calendar.self_only_events', 'gmail.send.to_recipient' */
    templateKey: text('template_key').notNull(),
    /** Template params, e.g. { recipient: 'jon@x.is' }. */
    match: jsonb('match').notNull().default({}),
    effect: text('effect').notNull(),
    version: integer('version').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdVia: text('created_via').notNull(),
    ...timestamps,
  },
  (t) => [
    check('approval_policies_effect_check', sql`${t.effect} IN ('allow','deny')`),
    check(
      'approval_policies_created_via_check',
      sql`${t.createdVia} IN ('approval_dialog','settings','seed')`,
    ),
    index('approval_policies_tool_idx').on(t.agentId, t.toolName, t.enabled),
  ],
);

// ── Memory ───────────────────────────────────────────────────────────────────

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** knowledge: durable, similarity-retrieved. experience: expiring, recency/task-scoped. */
    category: text('category').notNull(),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull().unique(),
    embedding: vector('embedding', { dimensions: 1536 }),
    importance: smallint('importance').notNull().default(3),
    /** Extracted memories are often uncertain. 0..1 */
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.7'),
    /** Untrusted-origin saves are quarantined until owner review. */
    originTrust: text('origin_trust').notNull().default('owner'),
    quarantined: boolean('quarantined').notNull().default(false),
    /** Who this fact is ABOUT (the owner contact row, or an auto-created person). */
    subjectContactId: uuid('subject_contact_id').references(() => contacts.id),
    /** Lifecycle-tree domain (PersonaTree): identity → life domains → facts. */
    domain: text('domain'),
    /** Temporal validity ("worked at X 2019–2023"): null = open-ended. */
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    /** Set by consolidation when a newer/better fact supersedes this one. */
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => memories.id),
    /** Owner clicked confirm/correct on the Profile page — consolidation never expires these lightly. */
    ownerConfirmed: boolean('owner_confirmed').notNull().default(false),
    /** Owner pinned this fact: always included in the compiled owner card. */
    pinned: boolean('pinned').notNull().default(false),
    /** Import provenance (e.g. 'takeout-mail-2021') — purge-by-source uses this. */
    source: text('source'),
    sourceTaskId: uuid('source_task_id').references(() => tasks.id),
    goalId: uuid('goal_id').references(() => goals.id),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    /** Rotation cursor: when consolidation last reviewed this fact. Null = never. */
    lastConsolidatedAt: timestamp('last_consolidated_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('memories_category_check', sql`${t.category} IN ('knowledge','experience')`),
    check(
      'memories_kind_check',
      sql`${t.kind} IN ('fact','preference','person','project','episode')`,
    ),
    check(
      'memories_origin_trust_check',
      sql`${t.originTrust} IN ('owner','known','unknown','assistant')`,
    ),
    check(
      'memories_domain_check',
      sql`${t.domain} IS NULL OR ${t.domain} IN ('identity','work','home','relationships','preferences','health','other')`,
    ),
    index('memories_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('memories_agent_category_idx').on(t.agentId, t.category, t.createdAt),
    index('memories_subject_idx').on(t.subjectContactId),
    index('memories_source_idx').on(t.source),
  ],
);

/**
 * Forgotten facts stay forgotten: a tombstoned content hash can never be
 * re-saved by extraction, import, or memory.save. Only the hash is kept —
 * the content itself is gone.
 */
export const memoryTombstones = pgTable('memory_tombstones', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentHash: text('content_hash').notNull().unique(),
  reason: text('reason').notNull().default('owner_forget'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Compiled owner profile card (single row, id = 1) — rebuilt by consolidation
 * and injected into planner/executor system prompts. Computed once, not
 * re-derived per task.
 */
export const ownerCard = pgTable(
  'owner_card',
  {
    id: smallint('id').primaryKey().default(1),
    content: text('content').notNull().default(''),
    compiledAt: timestamp('compiled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('owner_card_singleton_check', sql`${t.id} = 1`)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    emails: text('emails').array().notNull().default([]),
    phones: text('phones').array().notNull().default([]),
    relationship: text('relationship').notNull().default(''),
    trust: text('trust').notNull().default('unknown'),
    notes: text('notes').notNull().default(''),
    ...timestamps,
  },
  (t) => [check('contacts_trust_check', sql`${t.trust} IN ('owner','known','unknown')`)],
);

/**
 * Backstory import sources (Phase 22): one row per archive dropped into the
 * workspace import/ prefix. `source` is the provenance tag stamped on every
 * memory the import produces — re-run or purge a whole source atomically.
 */
export const importSources = pgTable(
  'import_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Provenance tag, e.g. 'takeout-mail-2021'. Stamped on memories.source. */
    source: text('source').notNull().unique(),
    /** Path under the agent workspace prefix, e.g. 'import/mail-2021.mbox'. */
    workspacePath: text('workspace_path').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    taskId: uuid('task_id').references(() => tasks.id),
    itemsTotal: integer('items_total'),
    itemsProcessed: integer('items_processed').notNull().default(0),
    memoriesSaved: integer('memories_saved').notNull().default(0),
    memoriesQuarantined: integer('memories_quarantined').notNull().default(0),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    check('import_sources_kind_check', sql`${t.kind} IN ('mbox','json','text')`),
    check(
      'import_sources_status_check',
      sql`${t.status} IN ('pending','running','done','failed','purged')`,
    ),
  ],
);

// ── Models, routing, budgets ─────────────────────────────────────────────────

/** Capability matrix — what the router may pick. Swapping models = editing rows. */
export const models = pgTable(
  'models',
  {
    /** OpenRouter model id, e.g. 'anthropic/claude-sonnet-4.5'. */
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    /** { tools, vision, json, streaming, thinking } */
    capabilities: jsonb('capabilities').notNull().default({}),
    /** USD per million tokens — hints for routing, not billing (usage.cost is authoritative). */
    promptCostPerMTok: numeric('prompt_cost_per_mtok', { precision: 10, scale: 4 }),
    completionCostPerMTok: numeric('completion_cost_per_mtok', { precision: 10, scale: 4 }),
    latencyClass: text('latency_class').notNull().default('medium'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [check('models_latency_class_check', sql`${t.latencyClass} IN ('fast','medium','slow')`)],
);

export const modelRoles = pgTable(
  'model_roles',
  {
    role: text('role').primaryKey(),
    primaryModel: text('primary_model')
      .notNull()
      .references(() => models.id),
    fallbackModel: text('fallback_model')
      .notNull()
      .references(() => models.id),
    params: jsonb('params').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'model_roles_role_check',
      sql`${t.role} IN ('plan','classify','extract','draft','reason','rewrite','embed')`,
    ),
  ],
);

/** Usage metering — one row per model call; budget guard sums cost_usd. */
export const modelCalls = pgTable(
  'model_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id),
    role: text('role').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Authoritative per-request cost from OpenRouter usage.cost. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    finishReason: text('finish_reason'),
    openrouterGenerationId: text('openrouter_generation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('model_calls_created_idx').on(t.createdAt),
    index('model_calls_task_idx').on(t.taskId),
  ],
);

/**
 * Every billable event, whatever it costs money for (Phase 27). Model calls,
 * embeddings, SMS, job-seconds — one ledger, one dashboard number. Sources
 * must stay in sync with the CI wiring check in @assistant/core cost.ts.
 */
export const SPEND_SOURCES = [
  'model',
  'embedding',
  'twilio_sms',
  'twilio_voice_min',
  'cloud_run_job_sec',
  'storage_gb_month',
  'external_api',
] as const;
export type SpendSource = (typeof SPEND_SOURCES)[number];

export const costEvents = pgTable(
  'cost_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    taskId: uuid('task_id').references(() => tasks.id),
    toolCallId: uuid('tool_call_id').references(() => toolCalls.id),
    /** How much of the unit was consumed (tokens, messages, seconds, GB-months). */
    quantity: numeric('quantity', { precision: 14, scale: 4 }),
    unit: text('unit'),
    unitPriceUsd: numeric('unit_price_usd', { precision: 12, scale: 8 }),
    usd: numeric('usd', { precision: 10, scale: 6 }).notNull(),
    description: text('description').notNull().default(''),
    /** Set when this event reconciles a pre-flight reservation. */
    reservationId: uuid('reservation_id').references((): AnyPgColumn => costReservations.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'cost_events_source_check',
      sql`${t.source} IN ('model','embedding','twilio_sms','twilio_voice_min','cloud_run_job_sec','storage_gb_month','external_api')`,
    ),
    index('cost_events_created_idx').on(t.createdAt),
    index('cost_events_task_idx').on(t.taskId),
    index('cost_events_source_idx').on(t.source, t.createdAt),
  ],
);

/**
 * Pre-flight budget reservations: expensive actions (job launches, outbound
 * calls, batch imports) reserve their estimate BEFORE starting — post-hoc
 * metering alone can't prevent overshoot. Held reservations count against
 * remaining budget until reconciled to actuals or released.
 */
export const costReservations = pgTable(
  'cost_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id),
    source: text('source').notNull(),
    estimatedUsd: numeric('estimated_usd', { precision: 10, scale: 6 }).notNull(),
    status: text('status').notNull().default('held'),
    actualUsd: numeric('actual_usd', { precision: 10, scale: 6 }),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  },
  (t) => [
    check('cost_reservations_status_check', sql`${t.status} IN ('held','reconciled','released')`),
    index('cost_reservations_status_idx').on(t.status, t.createdAt),
  ],
);

/** Unit prices for non-model spend (model costs come from OpenRouter usage.cost). */
export const rateTable = pgTable('rate_table', {
  /** e.g. 'twilio_sms', 'cloud_run_job_sec', 'embedding_mtok'. */
  key: text('key').primaryKey(),
  unit: text('unit').notNull(),
  unitPriceUsd: numeric('unit_price_usd', { precision: 12, scale: 8 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const budgets = pgTable(
  'budgets',
  {
    scope: text('scope').primaryKey(),
    limitUsd: numeric('limit_usd', { precision: 8, scale: 2 }).notNull(),
    softPct: integer('soft_pct').notNull().default(80),
    onSoft: text('on_soft').notNull().default('degrade'),
    onHard: text('on_hard').notNull().default('park'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('budgets_scope_check', sql`${t.scope} IN ('task_default','daily','monthly')`),
    check('budgets_on_soft_check', sql`${t.onSoft} IN ('degrade')`),
    check('budgets_on_hard_check', sql`${t.onHard} IN ('park','block')`),
  ],
);

// ── Caching & rate limiting ──────────────────────────────────────────────────

export const toolCache = pgTable(
  'tool_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    toolName: text('tool_name').notNull(),
    result: jsonb('result').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('tool_cache_expires_idx').on(t.expiresAt)],
);

export const rateLimits = pgTable('rate_limits', {
  /** 'tool:gmail.send' | 'task' | 'channel:sms' | ... */
  scope: text('scope').primaryKey(),
  maxPerHour: integer('max_per_hour'),
  maxPerDay: integer('max_per_day'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Voice ────────────────────────────────────────────────────────────────────

export const writingSamples = pgTable(
  'writing_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    register: text('register').notNull(),
    text: text('text').notNull(),
    context: text('context').notNull().default(''),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'writing_samples_register_check',
      sql`${t.register} IN ('email_professional','email_casual','sms','chat')`,
    ),
    index('writing_samples_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** Single row (id = 1 enforced by check). */
export const voiceProfile = pgTable(
  'voice_profile',
  {
    id: smallint('id').primaryKey().default(1),
    description: text('description').notNull().default(''),
    dos: jsonb('dos').notNull().default([]),
    donts: jsonb('donts').notNull().default([]),
    signature: text('signature').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('voice_profile_singleton_check', sql`${t.id} = 1`)],
);

// ── Channel sync state & scheduling ──────────────────────────────────────────

export const gmailSyncState = pgTable('gmail_sync_state', {
  mailbox: text('mailbox').primaryKey(),
  lastHistoryId: bigint('last_history_id', { mode: 'bigint' }),
  watchExpiration: timestamp('watch_expiration', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    /** Template for the task the tick creates: { type, trigger, budgetUsdLimit, ... } */
    taskTemplate: jsonb('task_template').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('schedules_enabled_next_idx').on(t.enabled, t.nextRunAt)],
);

// ── Workspace files ──────────────────────────────────────────────────────────

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    taskId: uuid('task_id').references(() => tasks.id),
    /** Path under the agent's workspace prefix in GCS. */
    workspacePath: text('workspace_path').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('files_agent_idx').on(t.agentId, t.createdAt)],
);

// ── Inferred row types ───────────────────────────────────────────────────────

export type AgentRow = typeof agents.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalPolicyRow = typeof approvalPolicies.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type MemoryTombstoneRow = typeof memoryTombstones.$inferSelect;
export type OwnerCardRow = typeof ownerCard.$inferSelect;
export type ImportSourceRow = typeof importSources.$inferSelect;
export type CostEventRow = typeof costEvents.$inferSelect;
export type CostReservationRow = typeof costReservations.$inferSelect;
export type RateRow = typeof rateTable.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type ModelRoleRow = typeof modelRoles.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
