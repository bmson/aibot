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

// ── External MCP connections ────────────────────────────────────────────────

/**
 * Owner-configured remote Model Context Protocol servers. The endpoint and
 * server-advertised tool metadata are durable; credentials deliberately are
 * not. An authorization-required server stays visible as such instead of
 * encouraging the app to persist bearer tokens in the database.
 */
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Human name selected by the owner, e.g. "Linear" or "Home Assistant". */
    name: text('name').notNull(),
    /** One Streamable HTTP endpoint, normalized and validated before persistence. */
    endpoint: text('endpoint').notNull(),
    /** ready | checking | authorization_required | error | disabled */
    status: text('status').notNull().default('checking'),
    enabled: boolean('enabled').notNull().default(true),
    serverName: text('server_name'),
    serverVersion: text('server_version'),
    instructions: text('instructions'),
    /** Sanitized `tools/list` response; never trusted as an instruction source. */
    tools: jsonb('tools').notNull().default([]),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    check(
      'mcp_connections_status_check',
      sql`${t.status} IN ('ready','checking','authorization_required','error','disabled')`,
    ),
    uniqueIndex('mcp_connections_agent_name_idx').on(t.agentId, t.name),
    index('mcp_connections_agent_status_idx').on(t.agentId, t.status),
  ],
);

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
    /**
     * Opt-in: also post this goal's autonomous mission updates into the owner's
     * primary chat thread, so background work shows up in the one discussion
     * (long-running-chat design, option B). Off by default to avoid noise.
     */
    mirrorToPrimary: boolean('mirror_to_primary').notNull().default(false),
    /**
     * True when this goal was created from a tainted (externally-influenced)
     * session — e.g. the model proposed goals.create while a forwarded email or
     * fetched page was in context. Its recurring automation sessions then start
     * tainted, so any web egress or outward action they attempt is owner-gated
     * instead of autonomous. A goal the owner creates directly is untainted.
     */
    taintedOrigin: boolean('tainted_origin').notNull().default(false),
    /**
     * Owner opt-in "free-range" mode: every automatic work session this goal
     * spawns is armed with an autonomy grant, so it may consult memory AND act
     * outward without parking each call for approval (the same hard floor as a
     * per-task grant still applies: memory writes under taint, unverified
     * recipients, interactive browser/networked code, and policy denies). A
     * tainted-origin goal can never be armed. Off by default.
     */
    autonomy: boolean('autonomy').notNull().default(false),
    /** Owner-hidden goal history. Linked chats, tasks, and evidence stay intact. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
    /**
     * The single canonical chat thread the UI opens by default (Phase 3 of the
     * long-running-chat design). At most one per agent, enforced below.
     */
    isPrimary: boolean('is_primary').notNull().default(false),
    metadata: jsonb('metadata').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('conversations_channel_check', sql`${t.channel} IN ('chat','sms','email')`),
    check('conversations_trust_check', sql`${t.trust} IN ('owner','known','unknown','assistant')`),
    index('conversations_agent_idx').on(t.agentId, t.updatedAt),
    uniqueIndex('conversations_primary_idx').on(t.agentId).where(sql`${t.isPrimary}`),
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
    index('messages_created_idx').on(t.createdAt),
    index('messages_task_created_idx')
      .on(t.taskId, t.createdAt)
      .where(sql`${t.taskId} IS NOT NULL`),
    index('messages_embedding_backfill_idx')
      .on(t.createdAt)
      .where(
        sql`${t.embedding} IS NULL AND ${t.role} IN ('user','assistant') AND length(${t.text}) > 20`,
      ),
    index('messages_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/**
 * Topic segments over the single long-running chat (Phase 2 of the
 * long-running-chat design). Each segment is a contiguous run of messages on
 * one topic within a conversation, with a rolling summary + embedding. Recall
 * matches the SUMMARY embedding — a far better retrieval unit than lone
 * messages — and injects the summary plus a key line. Produced offline by the
 * `chat.segment` code job; never written on the chat hot path.
 */
export const conversationSegments = pgTable(
  'conversation_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    /** Inclusive message range this segment summarizes. */
    startMessageId: uuid('start_message_id')
      .notNull()
      .references(() => messages.id),
    endMessageId: uuid('end_message_id')
      .notNull()
      .references(() => messages.id),
    /** Rolling topic summary — the recall retrieval unit. */
    summary: text('summary').notNull().default(''),
    embedding: vector('embedding', { dimensions: 1536 }),
    messageCount: integer('message_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index('conversation_segments_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('conversation_segments_conversation_idx').on(t.conversationId, t.endedAt),
    index('conversation_segments_agent_idx').on(t.agentId, t.endedAt),
    // Idempotent re-runs: a given start message anchors at most one segment.
    uniqueIndex('conversation_segments_start_idx').on(t.conversationId, t.startMessageId),
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
    /** Short human title for activity/approval UIs (planner-authored; falls back to the instruction). */
    title: text('title'),
    /**
     * Owner-armed "free-range" grant (Phase 3). When present, unexpired, and
     * unrevoked, the dispatcher downgrades an otherwise approval-gated call to
     * autonomous — EXCEPT the hard floor (memory writes under taint, unverified
     * recipients, interactive browser / networked code, policy denies, budget).
     * Never armed from a tainted-origin task. See workflow/autonomy.ts.
     */
    autonomyGrant: jsonb('autonomy_grant'),
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
    /** Monotonic delivery generation used to deduplicate queue pokes per runnable transition. */
    queueGeneration: integer('queue_generation').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    /**
     * Times this task's lease was reclaimed after expiring while 'running'
     * (a worker that hung or was killed without throwing, so it never recorded
     * a failed attempt). Reset to 0 whenever a step checkpoints. Bounds the
     * poison-pill loop: a task reclaimed this many times without progress
     * dead-letters to needs_attention instead of churning forever.
     */
    reclaimCount: integer('reclaim_count').notNull().default(0),
    maxSteps: integer('max_steps').notNull().default(12),
    budgetUsdLimit: numeric('budget_usd_limit', { precision: 8, scale: 4 })
      .notNull()
      .default('0.50'),
    spentUsd: numeric('spent_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id),
    /** Owner-hidden terminal history. Evidence stays intact and can be restored. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * Set when the owner has been told this task needs them (needs_attention or
     * waiting_event). Nulled on every entry into those states and on wake, so the
     * re-notify sweep (workflow/attention.ts) can re-emit a notice for any task
     * whose park→notify was lost to a crash. Mirrors approvals.notified_channels.
     */
    attentionNotifiedAt: timestamp('attention_notified_at', { withTimezone: true }),
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
    // The chat view and its status poller filter by conversation on every
    // render/poll; goal views filter by goal. Postgres does not index FKs.
    index('tasks_conversation_idx').on(t.conversationId, t.status),
    index('tasks_goal_idx').on(t.goalId),
    index('tasks_pending_updated_idx').on(t.updatedAt).where(sql`${t.status} = 'pending'`),
    index('tasks_sleeping_run_after_idx')
      .on(t.runAfter)
      .where(sql`${t.status} IN ('sleeping','waiting_budget')`),
    index('tasks_running_locked_idx').on(t.lockedUntil).where(sql`${t.status} = 'running'`),
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
    index('tool_calls_rate_idx').on(t.toolName, t.status, t.createdAt),
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
    index('approvals_task_requested_idx').on(t.taskId, t.requestedAt),
  ],
);

// ── Pre-authorized cross-event workflows ────────────────────────────────────

/**
 * One owner-approved application-confirmation watch. The untrusted email never
 * supplies a Sheet destination or values: those exact arguments are frozen in
 * tracker_update when the owner approves the watch.
 */
export const applicationConfirmations = pgTable(
  'application_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    sourceTaskId: uuid('source_task_id')
      .notNull()
      .references(() => tasks.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    company: text('company').notNull(),
    role: text('role').notNull(),
    expectedSenderEmails: text('expected_sender_emails').array().notNull(),
    /** SHA-256 of an opaque, case-normalized receipt/requisition token. */
    confirmationTokenHash: text('confirmation_token_hash').notNull(),
    /** Non-sensitive last four characters for owner-facing audit messages. */
    confirmationTokenHint: text('confirmation_token_hint').notNull(),
    /** { spreadsheetId, sheetName, startCell, rows } approved before email arrival. */
    trackerUpdate: jsonb('tracker_update'),
    /** { documentId, content } approved before email arrival. */
    documentUpdate: jsonb('document_update'),
    /** Per-action durable state: { sheet?: { status }, document?: { status } }. */
    actionState: jsonb('action_state').notNull().default({}),
    status: text('status').notNull().default('awaiting_confirmation'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmationMessageId: text('confirmation_message_id'),
    confirmationFrom: text('confirmation_from'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    check(
      'application_confirmations_status_check',
      sql`${t.status} IN ('awaiting_confirmation','confirmation_received','updated','partially_updated','update_unknown','update_failed','cancelled','expired')`,
    ),
    uniqueIndex('application_confirmations_message_idx')
      .on(t.confirmationMessageId)
      .where(sql`${t.confirmationMessageId} IS NOT NULL`),
    uniqueIndex('application_confirmations_active_token_idx')
      .on(t.agentId, t.confirmationTokenHash)
      .where(sql`${t.status} = 'awaiting_confirmation'`),
    index('application_confirmations_pending_idx').on(t.agentId, t.status, t.expiresAt),
    index('application_confirmations_source_task_idx').on(t.sourceTaskId),
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
    uniqueIndex('approval_policies_identity_idx').on(
      t.agentId,
      t.toolName,
      t.templateKey,
      t.match,
      t.effect,
    ),
  ],
);

/**
 * Approval anomaly detection (Phase 18): a nightly scan over `tool_calls.decision`
 * flags policies auto-executing far above their baseline, outward-facing actions
 * at unusual hours, or bursts. Each row cites the triggering tool_calls. Suspend
 * reuses `approval_policies.enabled`; dismissing raises the effective baseline.
 */
export const anomalies = pgTable(
  'anomalies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    kind: text('kind').notNull(),
    /** The policy whose auto-executions triggered this — plain id, no FK (policies can be deleted). */
    policyId: uuid('policy_id'),
    toolName: text('tool_name').notNull(),
    observed: integer('observed').notNull(),
    /** The baseline/threshold the observation exceeded. */
    expected: integer('expected').notNull().default(0),
    /** tool_calls.id values that evidence this anomaly (citations). */
    toolCallIds: text('tool_call_ids').array().notNull().default([]),
    detail: text('detail').notNull().default(''),
    /** Stable window key for dedup, e.g. '2026-07-21' (daily) or a burst-start ISO minute. */
    windowLabel: text('window_label').notNull(),
    /** policyId or toolName — the dedup subject (policyId may be null). */
    subjectKey: text('subject_key').notNull(),
    status: text('status').notNull().default('open'),
    ...timestamps,
  },
  (t) => [
    check('anomalies_kind_check', sql`${t.kind} IN ('frequency','off_hours','burst')`),
    check('anomalies_status_check', sql`${t.status} IN ('open','dismissed','suspended')`),
    uniqueIndex('anomalies_dedup_idx').on(t.agentId, t.kind, t.subjectKey, t.windowLabel),
    index('anomalies_status_idx').on(t.agentId, t.status),
  ],
);

/**
 * Deterministic operational alerts for one assistant. Unlike approval
 * anomalies, these track a currently unhealthy subsystem across monitor runs
 * so a persistent incident is visible without creating a daily notification
 * storm.
 */
export const assistantHealthAlerts = pgTable(
  'assistant_health_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    detail: text('detail').notNull().default(''),
    status: text('status').notNull().default('open'),
    observationCount: integer('observation_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('assistant_health_alerts_status_check', sql`${t.status} IN ('open','resolved')`),
    uniqueIndex('assistant_health_alerts_agent_kind_idx').on(t.agentId, t.kind),
    index('assistant_health_alerts_open_idx').on(t.agentId, t.status, t.lastSeenAt),
  ],
);

/**
 * Skill library (Phase 26): Voyager-style competence memory, kept separate from
 * facts. A post-task reflection distills a named procedure — preconditions,
 * steps (advice, never auto-run code), gotchas, and provenance — from a task
 * that succeeded a non-obvious way. Embedded for retrieval into planning; carries
 * a use/success lifecycle and is revised or deprecated on failure. Only
 * owner/assistant-trust (non-tainted) work may write a skill.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    /** When this procedure applies. */
    preconditions: text('preconditions').notNull().default(''),
    /** The procedure itself — advice the model reads before acting, not executable code. */
    steps: text('steps').notNull(),
    /** Pitfalls learned the hard way. */
    gotchas: text('gotchas').notNull().default(''),
    embedding: vector('embedding', { dimensions: 1536 }),
    /** The task that taught it (plain id, no FK — a skill outlives its source task). */
    sourceTaskId: uuid('source_task_id'),
    originTrust: text('origin_trust').notNull().default('assistant'),
    ownerAuthored: boolean('owner_authored').notNull().default(false),
    useCount: integer('use_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    deprecated: boolean('deprecated').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check('skills_origin_trust_check', sql`${t.originTrust} IN ('owner','assistant')`),
    uniqueIndex('skills_name_idx').on(t.agentId, t.name),
    index('skills_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('skills_active_idx').on(t.agentId, t.deprecated),
  ],
);

/**
 * Self-improvement proposals (Phase 12): a nightly eval mines failures, retries,
 * dead-letters, and cost outliers into concrete, owner-approved change proposals
 * — a model-role swap, an approval-policy adjustment, or an advisory prompt/note.
 * NEVER auto-applied: the owner approves, dismisses, and only then is an
 * applyable change (model_role, policy) enacted. `change` is kind-specific.
 */
export const improvementProposals = pgTable(
  'improvement_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    rationale: text('rationale').notNull().default(''),
    /** The concrete change to enact on approval, kind-specific (empty for advisory kinds). */
    change: jsonb('change').notNull().default({}),
    /** tool_calls.id / task.id values that evidence the pattern. */
    evidenceIds: text('evidence_ids').array().notNull().default([]),
    status: text('status').notNull().default('open'),
    ...timestamps,
  },
  (t) => [
    check(
      'improvement_proposals_kind_check',
      sql`${t.kind} IN ('model_role','policy','prompt','note')`,
    ),
    check('improvement_proposals_status_check', sql`${t.status} IN ('open','applied','dismissed')`),
    uniqueIndex('improvement_proposals_dedup_idx').on(t.agentId, t.kind, t.title),
    index('improvement_proposals_status_idx').on(t.agentId, t.status),
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
    /** Prior/manual names used by entity resolution after a canonical rename. */
    aliases: text('aliases').array().notNull().default([]),
    emails: text('emails').array().notNull().default([]),
    phones: text('phones').array().notNull().default([]),
    relationship: text('relationship').notNull().default(''),
    trust: text('trust').notNull().default('unknown'),
    notes: text('notes').notNull().default(''),
    ...timestamps,
  },
  (t) => [check('contacts_trust_check', sql`${t.trust} IN ('owner','known','unknown')`)],
);

// ── Knowledge graph ────────────────────────────────────────────────────────

/**
 * GraphRAG is an explainable index over the existing durable-memory store, not
 * a second source of truth. A node's canonical key is stable across spelling
 * and contact-label changes; people also retain a direct link to contacts.
 */
export const knowledgeGraphEntities = pgTable(
  'knowledge_graph_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** `contact:<id>` for people, otherwise `<kind>:<normalized label>`. */
    canonicalKey: text('canonical_key').notNull(),
    label: text('label').notNull(),
    /** Owner-curated display name; extraction keeps the stable canonical key. */
    preferredLabel: text('preferred_label'),
    kind: text('kind').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    check(
      'knowledge_graph_entities_kind_check',
      sql`${t.kind} IN ('person','organization','project','place','event','date','topic')`,
    ),
    uniqueIndex('knowledge_graph_entities_agent_key_idx').on(t.agentId, t.canonicalKey),
    index('knowledge_graph_entities_contact_idx').on(t.contactId),
  ],
);

/**
 * Canonical keys that the owner merged into another graph entity. Extraction
 * resolves these aliases before it creates a node, so a curation decision
 * survives a future source edit or a backfill.
 */
export const knowledgeGraphEntityAliases = pgTable(
  'knowledge_graph_entity_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    canonicalKey: text('canonical_key').notNull(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_graph_entity_aliases_agent_key_idx').on(t.agentId, t.canonicalKey),
    index('knowledge_graph_entity_aliases_entity_idx').on(t.entityId),
  ],
);

/**
 * Per-memory extraction checkpoint. `content_hash` means edits naturally make
 * a source dirty without requiring every memory writer to know about GraphRAG.
 */
export const knowledgeGraphSources = pgTable(
  'knowledge_graph_sources',
  {
    memoryId: uuid('memory_id')
      .primaryKey()
      .references(() => memories.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    /** Tracks contact reassignment/merges separately from content edits. */
    subjectContactId: uuid('subject_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('pending'),
    /** Bump when extraction requirements change so old edges are rebuilt safely. */
    extractionVersion: integer('extraction_version').notNull().default(1),
    /** Automatic retry deadline after a transient extraction failure. */
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    check(
      'knowledge_graph_sources_status_check',
      sql`${t.status} IN ('pending','ready','failed','quarantined')`,
    ),
    index('knowledge_graph_sources_status_idx').on(t.status, t.updatedAt),
  ],
);

/**
 * A direct relationship explicitly supported by exactly one memory fact.
 * Traversal can connect these edges at read time, but never writes inferred
 * relationships back into the graph.
 */
export const knowledgeGraphRelations = pgTable(
  'knowledge_graph_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    subjectEntityId: uuid('subject_entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    predicate: text('predicate').notNull(),
    objectEntityId: uuid('object_entity_id')
      .notNull()
      .references(() => knowledgeGraphEntities.id, { onDelete: 'cascade' }),
    sourceMemoryId: uuid('source_memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    /** Exact source phrase supplied by the extractor for this direct edge. */
    evidenceQuote: text('evidence_quote'),
    /** Stable endpoint/predicate identity within a source memory. */
    sourceFingerprint: text('source_fingerprint').notNull(),
    /** The source fact can yield several direct relationships. */
    ordinal: smallint('ordinal').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('0.70'),
    /** Owner curation; rejected edges are excluded from graph recall. */
    reviewStatus: text('review_status').notNull().default('unreviewed'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'knowledge_graph_relations_predicate_check',
      sql`length(${t.predicate}) BETWEEN 1 AND 80`,
    ),
    check(
      'knowledge_graph_relations_review_status_check',
      sql`${t.reviewStatus} IN ('unreviewed','confirmed','rejected')`,
    ),
    uniqueIndex('knowledge_graph_relations_source_fingerprint_idx').on(
      t.sourceMemoryId,
      t.sourceFingerprint,
    ),
    index('knowledge_graph_relations_subject_idx').on(t.agentId, t.subjectEntityId),
    index('knowledge_graph_relations_object_idx').on(t.agentId, t.objectEntityId),
    index('knowledge_graph_relations_review_idx').on(t.agentId, t.reviewStatus),
  ],
);

/**
 * Occasions (Phase 17): recurring dates tied to a contact — birthdays,
 * anniversaries, and custom dates the assistant surfaces at lead time. Month/day
 * drive annual recurrence; `year` is optional (often unknown for a birthday).
 * Provenance mirrors memories: an occasion learned from an untrusted email waits
 * quarantined until the owner reviews it.
 */
export const occasions = pgTable(
  'occasions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    kind: text('kind').notNull(),
    /** Free-text label for a custom occasion (e.g. "graduation"); '' otherwise. */
    label: text('label').notNull().default(''),
    month: smallint('month').notNull(),
    day: smallint('day').notNull(),
    /** Optional — a birthday's year is frequently unknown. */
    year: smallint('year'),
    recurrence: text('recurrence').notNull().default('annual'),
    /** Days before the date to start surfacing it in the brief. */
    leadDays: smallint('lead_days').notNull().default(7),
    /** Gift ideas / context for this occasion. */
    notes: text('notes').notNull().default(''),
    originTrust: text('origin_trust').notNull().default('owner'),
    quarantined: boolean('quarantined').notNull().default(false),
    ownerConfirmed: boolean('owner_confirmed').notNull().default(false),
    source: text('source'),
    ...timestamps,
  },
  (t) => [
    check('occasions_kind_check', sql`${t.kind} IN ('birthday','anniversary','custom')`),
    check('occasions_recurrence_check', sql`${t.recurrence} IN ('annual','once')`),
    check('occasions_month_check', sql`${t.month} >= 1 AND ${t.month} <= 12`),
    check('occasions_day_check', sql`${t.day} >= 1 AND ${t.day} <= 31`),
    check(
      'occasions_origin_trust_check',
      sql`${t.originTrust} IN ('owner','known','unknown','assistant')`,
    ),
    uniqueIndex('occasions_dedup_idx').on(t.agentId, t.contactId, t.kind, t.month, t.day),
    index('occasions_contact_idx').on(t.contactId),
    index('occasions_month_day_idx').on(t.month, t.day),
  ],
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
      sql`${t.role} IN ('plan','classify','extract','draft','reason','rewrite','embed','batch')`,
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
    uniqueIndex('cost_events_reservation_idx')
      .on(t.reservationId)
      .where(sql`${t.reservationId} IS NOT NULL`),
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
    index('cost_reservations_task_idx').on(t.taskId, t.status),
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
  /** Durable bounded-drain cursor for Gmail history/inbox reconciliation pages. */
  cursor: jsonb('cursor').notNull().default({}),
  watchExpiration: timestamp('watch_expiration', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The verdict on one ingested message: what it was about, how much it mattered,
 * and whether that earned a triage task.
 *
 * This exists because in `forwarded` ingest mode nothing is dropped any more —
 * the pipeline stores everything and *decides* rather than filtering. That
 * decision has to be durable for three reasons: the digest reports on it, the
 * memory extraction job walks it (rather than sampling conversations, which
 * badly under-samples a real inbox), and re-delivery must not re-score or
 * re-enqueue. `channelMessageId` carries the same `gmail:<id>` value used as the
 * task's `externalEventId`, so the unique index is the idempotency fence.
 */
export const emailIngest = pgTable(
  'email_ingest',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /** `gmail:<messageId>` — matches tasks.external_event_id for the triage task. */
    channelMessageId: text('channel_message_id').notNull(),
    fromEmail: text('from_email').notNull(),
    subject: text('subject').notNull().default(''),
    /**
     * Trust derived from the SENDER, kept separate from the task's trust (which
     * in forwarded mode is the OWNER, who directed the ingest). This is the axis
     * memory quarantine and importance scoring read.
     */
    contentTrust: text('content_trust').notNull().default('unknown'),
    /** Receiver-authenticated (aligned SPF/DKIM/DMARC). Forwarding often breaks SPF. */
    authenticated: boolean('authenticated').notNull().default(false),
    category: text('category').notNull().default('other'),
    importance: smallint('importance').notNull().default(1),
    actionable: boolean('actionable').notNull().default(false),
    /** One short sentence explaining the score, shown in the digest. */
    reason: text('reason').notNull().default(''),
    /** Dates the scorer found: [{ iso, what }] — the raw material for occasions. */
    dates: jsonb('dates').notNull().default([]),
    /** A triage task was enqueued (i.e. the score cleared the threshold). */
    triaged: boolean('triaged').notNull().default(false),
    /** Set once memory extraction has walked this row. */
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_ingest_message_idx').on(t.channelMessageId),
    index('email_ingest_agent_created_idx').on(t.agentId, t.createdAt),
    // The extraction job's scan: un-extracted rows, oldest first.
    index('email_ingest_extract_idx').on(t.extractedAt, t.createdAt),
    check('email_ingest_importance_check', sql`${t.importance} BETWEEN 1 AND 5`),
    check(
      'email_ingest_content_trust_check',
      sql`${t.contentTrust} IN ('owner','known','unknown')`,
    ),
  ],
);

/**
 * "I noticed X — want me to Y?"
 *
 * Approvals and needs-attention could not carry this. An approval attaches to a
 * tool call that is already queued and frozen, so it cannot represent work that
 * does not exist yet; needs-attention is a terminal status with nothing on the
 * other side of it. A suggestion is the missing middle: inert text until the
 * owner promotes it, and promotion enqueues an ordinary task that runs the
 * whole normal pipeline — so a suggestion never authored an outward action, it
 * only ever asked.
 *
 * That is what keeps the anticipation layer's invariant intact while letting
 * untrusted content *propose*: the proposal is a sentence, and the owner is the
 * one who turns it into work.
 */
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Where it was surfaced, so accepting can continue in the same thread. */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /** What was noticed, in the owner's terms. */
    summary: text('summary').notNull(),
    /** The planner seed run verbatim on acceptance — never a frozen tool call. */
    proposedAction: text('proposed_action').notNull(),
    /** What produced it: 'briefing' today, a `suggest`-tier watch later. */
    origin: text('origin').notNull().default('briefing'),
    /**
     * What it was noticed from (e.g. `gmail:<id>:calendar`). Unique per agent,
     * so re-running the producer re-proposes nothing the owner already saw —
     * or already dismissed.
     */
    sourceRef: text('source_ref').notNull(),
    status: text('status').notNull().default('pending'),
    /** The task acceptance created, for tracing the proposal to its work. */
    acceptedTaskId: uuid('accepted_task_id').references((): AnyPgColumn => tasks.id),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('suggestions_source_idx').on(t.agentId, t.sourceRef),
    index('suggestions_status_idx').on(t.agentId, t.status, t.expiresAt),
    check(
      'suggestions_status_check',
      sql`${t.status} IN ('pending','accepted','dismissed','snoozed','expired')`,
    ),
  ],
);

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
  (t) => [
    index('schedules_enabled_next_idx').on(t.enabled, t.nextRunAt),
    uniqueIndex('schedules_agent_name_idx').on(t.agentId, t.name),
  ],
);

// ── Watchers (anticipation layer) ────────────────────────────────────────────

/**
 * An owner-defined condition the assistant waits on ("tell me if X emails").
 * See docs/anticipation-layer.md. Phase 1 is deliberately narrow — enforced by
 * the CHECKs below, not by prompt: kind='email' and tier='notify', so a match
 * only *informs* the owner and takes no outward action. Untrusted trigger
 * content selects a watch; it never authors an action. Later phases widen the
 * enums by migration.
 */
export const watches = pgTable(
  'watches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Where notices for this watch are posted (a chat the owner can see). */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    kind: text('kind').notNull().default('email'),
    tier: text('tier').notNull().default('notify'),
    name: text('name').notNull(),
    /**
     * Match spec. email: { expectedSenderEmails: string[], keywords?: string[] }.
     * web: { url: string, mode: 'change'|'contains'|'absent', pattern?: string }.
     */
    match: jsonb('match').notNull().default({}),
    status: text('status').notNull().default('active'),
    fireCount: integer('fire_count').notNull().default(0),
    /** Stop after this many fires; null = fire on every match until expiry. */
    maxFires: integer('max_fires'),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    /**
     * Polling watches only (kind='web'): when this watch is next due to be
     * polled, and how often. Null for event-driven ('email') watches.
     */
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    pollIntervalSeconds: integer('poll_interval_seconds'),
    /**
     * Poller-owned observation state, e.g. { fingerprint, present, failures }
     * for a web watch. Opaque to everything but the matcher; empty for email.
     */
    state: jsonb('state').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    check('watches_kind_check', sql`${t.kind} IN ('email','web')`),
    check('watches_tier_check', sql`${t.tier} IN ('notify')`),
    check('watches_status_check', sql`${t.status} IN ('active','fired','expired','cancelled')`),
    index('watches_active_idx').on(t.agentId, t.status, t.kind, t.expiresAt),
    // The web-watch poller's due-selection/claim query.
    index('watches_due_web_idx').on(t.status, t.kind, t.nextPollAt),
  ],
);

/**
 * One recorded firing of a watch. Unique per (watch, trigger) so at-least-once
 * delivery and Gmail history replays never double-notify — the same
 * message-level idempotency the confirmation ledger relies on.
 */
export const watchFires = pgTable(
  'watch_fires',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    watchId: uuid('watch_id')
      .notNull()
      .references(() => watches.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** Dedupe key for the triggering event, e.g. 'gmail:<messageId>'. */
    triggerRef: text('trigger_ref').notNull(),
    summary: text('summary').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watch_fires_watch_trigger_idx').on(t.watchId, t.triggerRef)],
);

/** Durable, machine-readable health checks for deployed channel integrations. */
export const canaryRuns = pgTable(
  'canary_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status').notNull().default('running'),
    ok: boolean('ok'),
    checks: jsonb('checks').notNull().default({}),
    error: text('error'),
    /** SHA-256 only: the browser worker receives the raw one-shot callback token. */
    browserCallbackTokenHash: text('browser_callback_token_hash'),
    /** Written exactly once by the credential-free browser worker callback. */
    browserResult: jsonb('browser_result'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('canary_runs_status_check', sql`${t.status} IN ('running','completed','failed')`),
    index('canary_runs_started_idx').on(t.startedAt),
  ],
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

// ── Document intelligence (Phase 11) ─────────────────────────────────────────

/**
 * A file promoted to a searchable document: an owner upload or an attachment
 * the assistant auto-filed from a trusted sender. The bytes live in the
 * workspace via the files inventory (`fileId`); extracted text is chunked into
 * `document_chunks` with embeddings behind the `documents.search` tool. Text
 * and PDF are extracted in-process; heavy formats (scans, images, office,
 * audio) are parked `status='pending'` with `extractor='pending_processor'`
 * for the future document-processor worker (Phase 14). A document's `trust`
 * carries into search results — a third-party attachment taints downstream.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** The stored bytes in the files inventory (holds the workspace path). */
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    title: text('title').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    /** Where it came from: 'upload' (owner) or 'email' (auto-filed attachment). */
    source: text('source').notNull().default('upload'),
    /** Free-form provenance: sender email, Gmail message id, conversation id. */
    sourceRef: text('source_ref').notNull().default(''),
    /** Trust of the content — a non-owner document taints search downstream. */
    trust: text('trust').notNull().default('owner'),
    /** Content hash: idempotent re-ingest and cross-source dedup. */
    sha256: text('sha256').notNull(),
    /** pending → extracting → ready | unsupported | failed. */
    status: text('status').notNull().default('pending'),
    /** Which extractor handled it: 'text' | 'pdf' | 'pending_processor' | ''. */
    extractor: text('extractor').notNull().default(''),
    chunkCount: integer('chunk_count').notNull().default(0),
    charCount: integer('char_count').notNull().default(0),
    error: text('error'),
    /**
     * Document-processor worker (Phase 14). While a heavy-format doc is out at
     * the credential-free processor, the one-shot callback token's SHA-256 lives
     * here (cleared on settle); processorStartedAt marks the launch for the
     * staleness/relaunch sweep; processedTextPath is the workspace blob of
     * extracted text the callback hands back to the documents.extract pipeline.
     */
    processorTokenHash: text('processor_token_hash'),
    processorStartedAt: timestamp('processor_started_at', { withTimezone: true }),
    /**
     * Launches consumed by this document. A worker that dies without calling
     * back (decompression bomb, OCR hang) would otherwise be relaunched every
     * staleness window forever; after PROCESSOR_MAX_ATTEMPTS the document is
     * marked failed instead.
     */
    processorAttempts: integer('processor_attempts').notNull().default(0),
    processedTextPath: text('processed_text_path'),
    ...timestamps,
  },
  (t) => [
    check(
      'documents_status_check',
      sql`${t.status} IN ('pending','extracting','ready','unsupported','failed')`,
    ),
    check('documents_trust_check', sql`${t.trust} IN ('owner','known','unknown','assistant')`),
    uniqueIndex('documents_dedup_idx').on(t.agentId, t.sha256),
    index('documents_agent_status_idx').on(t.agentId, t.status),
  ],
);

/**
 * A contiguous text chunk of a document with its embedding — the retrieval
 * unit for `documents.search`. Chunks are deleted and reinserted whole on
 * re-extraction, so `(document_id, chunk_index)` is unique.
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull().default(0),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_chunks_doc_idx').on(t.documentId, t.chunkIndex),
    index('document_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('document_chunks_agent_idx').on(t.agentId),
  ],
);

// ── Location context (Phase 15) ──────────────────────────────────────────────

/**
 * Owner location pings from an HMAC-signed iOS Shortcut / native app. Kept
 * deliberately transient — never long-term location history: the sweep purges
 * rows older than the owner-configurable retention window (LOCATION_RETENTION_DAYS),
 * and location never enters the semantic memory/embedding space or memory
 * extraction. The latest fresh ping is surfaced as ambient context to the
 * owner's own (non-tainted) prompts and the morning brief.
 */
export const locationPings = pgTable(
  'location_pings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    lat: numeric('lat', { precision: 9, scale: 6 }).notNull(),
    lng: numeric('lng', { precision: 9, scale: 6 }).notNull(),
    /** Optional human label the Shortcut may attach ("home", "office", a city). */
    label: text('label').notNull().default(''),
    accuracyM: integer('accuracy_m'),
    source: text('source').notNull().default('shortcut'),
    /** IANA id of the device's clock when the ping was captured (travel awareness). */
    timeZone: text('time_zone'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('location_pings_agent_idx').on(t.agentId, t.capturedAt)],
);

/**
 * Ambient "right now" context (Phase 25). A cheap, frequently-refreshed fusion
 * of the transient sources (location + weather today; calendar/health later) into
 * one compiled block plus derived flags, cached here so every planning step reads
 * it once instead of re-deriving — the same computed-once pattern as the owner
 * card. Operational cache, NOT memory: it is never read into extraction and never
 * becomes a durable fact; a stale snapshot is superseded by the next refresh.
 */
export const ambientSnapshots = pgTable('ambient_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id)
    .unique(),
  /** The rendered "right now" block injected into the prompt. */
  block: text('block').notNull().default(''),
  /** Derived boolean flags the planner can act on (raining_soon, traveling_away_from_home, …). */
  flags: jsonb('flags').notNull().default({}),
  /** Per-source freshness/values ({ location: {...}, weather: {...} }). */
  sources: jsonb('sources').notNull().default({}),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Dream notes (Phase 20 — offline cognition). A budget-capped nightly session
 * replays the day's failures (counterfactual footnotes), spots behavioral
 * patterns (→ quarantined low-confidence memories, stored in `memories`, not
 * here), and anticipates likely-tomorrow needs. The owner-facing observations
 * land here as short notes surfaced in the morning brief, kept 7 days for
 * inspection then purged by the sweep. Internal-only: the job dispatches no
 * tools, so it can never act outward.
 */
export const dreamNotes = pgTable(
  'dream_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** 'footnote' (while-you-slept observation) | 'anticipation' (likely-tomorrow prep). */
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    /** task/tool_call ids that evidence the note. */
    refIds: text('ref_ids').array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dream_notes_agent_idx').on(t.agentId, t.createdAt)],
);

/**
 * Self-maintenance backlog (Phase 21). Code-shaped findings the bot proposes to
 * fix in its OWN repo. Hard fences live in code (see workflow/self-maintenance.ts):
 * PR-only (never push to main / trigger a deploy), NEVER edit infra/ or the
 * approval/policy/trust code paths (the bot cannot widen its own autonomy), one
 * open self-PR at a time, self-labeled so anomaly detection watches the pattern,
 * and the MERGE IS ALWAYS the owner's. This table only tracks the backlog + PR
 * status; it grants no capability on its own.
 */
export const selfMaintenance = pgTable(
  'self_maintenance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    /** The self-improvement proposal (Phase 12) this came from, if any. */
    proposalId: uuid('proposal_id'),
    title: text('title').notNull(),
    diagnosis: text('diagnosis').notNull().default(''),
    /** The file/area the fix targets — validated against the fence before any PR. */
    targetArea: text('target_area').notNull().default(''),
    status: text('status').notNull().default('backlog'),
    /** Why a blocked item can't proceed (e.g. touches a protected path). */
    blockedReason: text('blocked_reason'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    ...timestamps,
  },
  (t) => [
    check(
      'self_maintenance_status_check',
      sql`${t.status} IN ('backlog','blocked','pr_open','merged','dismissed')`,
    ),
    uniqueIndex('self_maintenance_dedup_idx').on(t.agentId, t.title),
    index('self_maintenance_status_idx').on(t.agentId, t.status),
  ],
);

// ── Inferred row types ───────────────────────────────────────────────────────

export type AgentRow = typeof agents.$inferSelect;
export type McpConnectionRow = typeof mcpConnections.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ConversationSegmentRow = typeof conversationSegments.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ApplicationConfirmationRow = typeof applicationConfirmations.$inferSelect;
export type ApprovalPolicyRow = typeof approvalPolicies.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type MemoryTombstoneRow = typeof memoryTombstones.$inferSelect;
export type OwnerCardRow = typeof ownerCard.$inferSelect;
export type ImportSourceRow = typeof importSources.$inferSelect;
/**
 * One row per finalized model-driven task: the response-contract verdict plus
 * loop-health counters. This is the queryable quality signal — contract-block
 * rate per prompt version, no-tool-call retries per model — that a console.warn
 * could never aggregate. Written by the executor at finalize.
 */
export const responseChecks = pgTable(
  'response_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    promptVersion: integer('prompt_version').notNull(),
    plannerVersion: integer('planner_version'),
    /** The honesty gate rewrote or blocked an unsupported action claim. */
    blocked: boolean('blocked').notNull().default(false),
    unsupportedCount: integer('unsupported_count').notNull().default(0),
    /** Steps that were required to act but returned no tool call and were retried. */
    mustActRetries: integer('must_act_retries').notNull().default(0),
    /** Steps served by a fallback model (budget degradation or forced). */
    degradedSteps: integer('degraded_steps').notNull().default(0),
    /** A bounded self-review model call completed before final delivery. */
    outputVerificationAttempted: boolean('output_verification_attempted').notNull().default(false),
    /** The self-review supplied a replacement, re-checked by the response contract. */
    outputVerificationRevised: boolean('output_verification_revised').notNull().default(false),
    /** The optional review could not run (budget/provider), so the checked draft shipped. */
    outputVerificationUnavailable: boolean('output_verification_unavailable')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('response_checks_task_idx').on(t.taskId),
    index('response_checks_created_idx').on(t.createdAt),
  ],
);

/**
 * Privacy-preserving recall observability. It stores quality counters only —
 * never a query, retrieved memory, embedding, or rendered recall block.
 */
export const recallMetrics = pgTable(
  'recall_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** Direct chat path or the durable executor path. */
    path: text('path').notNull(),
    graphAttempted: boolean('graph_attempted').notNull().default(false),
    graphFailed: boolean('graph_failed').notNull().default(false),
    historyFailed: boolean('history_failed').notNull().default(false),
    graphCandidates: integer('graph_candidates').notNull().default(0),
    graphUsed: integer('graph_used').notNull().default(0),
    historyTier: text('history_tier').notNull().default('none'),
    historyUsed: integer('history_used').notNull().default(0),
    sourceCount: integer('source_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('recall_metrics_path_check', sql`${t.path} IN ('chat','executor')`),
    check('recall_metrics_tier_check', sql`${t.historyTier} IN ('segment','message','none')`),
    index('recall_metrics_agent_created_idx').on(t.agentId, t.createdAt),
    index('recall_metrics_task_idx').on(t.taskId),
  ],
);

export type ResponseCheckRow = typeof responseChecks.$inferSelect;
export type RecallMetricRow = typeof recallMetrics.$inferSelect;

export type CostEventRow = typeof costEvents.$inferSelect;
export type CostReservationRow = typeof costReservations.$inferSelect;
export type RateRow = typeof rateTable.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type OccasionRow = typeof occasions.$inferSelect;
export type AnomalyRow = typeof anomalies.$inferSelect;
export type AssistantHealthAlertRow = typeof assistantHealthAlerts.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;
export type ImprovementProposalRow = typeof improvementProposals.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentChunkRow = typeof documentChunks.$inferSelect;
export type LocationPingRow = typeof locationPings.$inferSelect;
export type AmbientSnapshotRow = typeof ambientSnapshots.$inferSelect;
export type DreamNoteRow = typeof dreamNotes.$inferSelect;
export type SelfMaintenanceRow = typeof selfMaintenance.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type ModelRoleRow = typeof modelRoles.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type EmailIngestRow = typeof emailIngest.$inferSelect;
export type SuggestionRow = typeof suggestions.$inferSelect;
export type WatchRow = typeof watches.$inferSelect;
export type WatchFireRow = typeof watchFires.$inferSelect;
export type CanaryRunRow = typeof canaryRuns.$inferSelect;
