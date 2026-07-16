CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"calendar_id" text,
	"phone_e164" text,
	"avatar_url" text,
	"signature" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'Atlantic/Reykjavik' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"workspace_prefix" text NOT NULL,
	"browser_profile_path" text,
	"credential_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"template_key" text NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effect" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_policies_effect_check" CHECK ("approval_policies"."effect" IN ('allow','deny')),
	CONSTRAINT "approval_policies_created_via_check" CHECK ("approval_policies"."created_via" IN ('approval_dialog','settings','seed'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"tool_call_id" uuid NOT NULL,
	"short_code" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution_payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_via" text,
	"expires_at" timestamp with time zone NOT NULL,
	"notified_channels" text[] DEFAULT '{}' NOT NULL,
	"created_policy_id" uuid,
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" IN ('pending','approved','denied','expired')),
	CONSTRAINT "approvals_resolved_via_check" CHECK ("approvals"."resolved_via" IS NULL OR "approvals"."resolved_via" IN ('web','sms'))
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"scope" text PRIMARY KEY NOT NULL,
	"limit_usd" numeric(8, 2) NOT NULL,
	"soft_pct" integer DEFAULT 80 NOT NULL,
	"on_soft" text DEFAULT 'degrade' NOT NULL,
	"on_hard" text DEFAULT 'park' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_scope_check" CHECK ("budgets"."scope" IN ('task_default','daily','monthly')),
	CONSTRAINT "budgets_on_soft_check" CHECK ("budgets"."on_soft" IN ('degrade')),
	CONSTRAINT "budgets_on_hard_check" CHECK ("budgets"."on_hard" IN ('park','block'))
);
--> statement-breakpoint
CREATE TABLE "channel_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_bindings_channel_check" CHECK ("channel_bindings"."channel" IN ('chat','sms','email'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"emails" text[] DEFAULT '{}' NOT NULL,
	"phones" text[] DEFAULT '{}' NOT NULL,
	"relationship" text DEFAULT '' NOT NULL,
	"trust" text DEFAULT 'unknown' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_trust_check" CHECK ("contacts"."trust" IN ('owner','known','unknown'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"trust" text DEFAULT 'unknown' NOT NULL,
	"model_override" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_channel_check" CHECK ("conversations"."channel" IN ('chat','sms','email')),
	CONSTRAINT "conversations_trust_check" CHECK ("conversations"."trust" IN ('owner','known','unknown','assistant'))
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"workspace_path" text NOT NULL,
	"mime" text DEFAULT 'application/octet-stream' NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_sync_state" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"last_history_id" bigint,
	"watch_expiration" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" smallint DEFAULT 3 NOT NULL,
	"progress" text DEFAULT '' NOT NULL,
	"next_action" text DEFAULT '' NOT NULL,
	"target_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_status_check" CHECK ("goals"."status" IN ('active','paused','done','abandoned'))
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"category" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"importance" smallint DEFAULT 3 NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.7' NOT NULL,
	"origin_trust" text DEFAULT 'owner' NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"source_task_id" uuid,
	"goal_id" uuid,
	"last_accessed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_content_hash_unique" UNIQUE("content_hash"),
	CONSTRAINT "memories_category_check" CHECK ("memories"."category" IN ('knowledge','experience')),
	CONSTRAINT "memories_kind_check" CHECK ("memories"."kind" IN ('fact','preference','person','project','episode')),
	CONSTRAINT "memories_origin_trust_check" CHECK ("memories"."origin_trust" IN ('owner','known','unknown','assistant'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"task_id" uuid,
	"role" text NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"origin" text NOT NULL,
	"channel_message_id" text,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('user','assistant','system','tool')),
	CONSTRAINT "messages_origin_check" CHECK ("messages"."origin" IN ('owner','known_contact','unknown','web','assistant','system'))
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"finish_reason" text,
	"openrouter_generation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_roles" (
	"role" text PRIMARY KEY NOT NULL,
	"primary_model" text NOT NULL,
	"fallback_model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_roles_role_check" CHECK ("model_roles"."role" IN ('plan','classify','extract','draft','reason','rewrite','embed'))
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_cost_per_mtok" numeric(10, 4),
	"completion_cost_per_mtok" numeric(10, 4),
	"latency_class" text DEFAULT 'medium' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_latency_class_check" CHECK ("models"."latency_class" IN ('fast','medium','slow'))
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"scope" text PRIMARY KEY NOT NULL,
	"max_per_hour" integer,
	"max_per_day" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"task_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"conversation_id" uuid,
	"goal_id" uuid,
	"trigger" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_event_id" text,
	"plan" jsonb,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" text DEFAULT '' NOT NULL,
	"progress_percent" smallint,
	"next_action" text DEFAULT '' NOT NULL,
	"deadline" timestamp with time zone,
	"reflect_every" interval,
	"last_reflected_at" timestamp with time zone,
	"trust" text DEFAULT 'unknown' NOT NULL,
	"run_after" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_steps" integer DEFAULT 12 NOT NULL,
	"budget_usd_limit" numeric(8, 4) DEFAULT '0.25' NOT NULL,
	"spent_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"parent_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_type_check" CHECK ("tasks"."type" IN ('chat_turn','sms_turn','email_triage','scheduled','mission','browser_job','adhoc')),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('pending','running','waiting_approval','waiting_event','sleeping','done','failed','needs_attention','cancelled')),
	CONSTRAINT "tasks_trust_check" CHECK ("tasks"."trust" IN ('owner','known','unknown','assistant')),
	CONSTRAINT "tasks_progress_percent_check" CHECK ("tasks"."progress_percent" IS NULL OR ("tasks"."progress_percent" >= 0 AND "tasks"."progress_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE "tool_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"tool_name" text NOT NULL,
	"result" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"idempotency_key" text,
	"result" jsonb,
	"error" text,
	"approval_id" uuid,
	"decision" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_calls_risk_check" CHECK ("tool_calls"."risk" IN ('autonomous','approval','forbidden')),
	CONSTRAINT "tool_calls_status_check" CHECK ("tool_calls"."status" IN ('proposed','awaiting_approval','approved','denied','executing','succeeded','failed'))
);
--> statement-breakpoint
CREATE TABLE "voice_profile" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"dos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"donts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profile_singleton_check" CHECK ("voice_profile"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "writing_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"register" text NOT NULL,
	"text" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writing_samples_register_check" CHECK ("writing_samples"."register" IN ('email_professional','email_casual','sms','chat'))
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_created_policy_id_approval_policies_id_fk" FOREIGN KEY ("created_policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_roles" ADD CONSTRAINT "model_roles_primary_model_models_id_fk" FOREIGN KEY ("primary_model") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_roles" ADD CONSTRAINT "model_roles_fallback_model_models_id_fk" FOREIGN KEY ("fallback_model") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_policies_tool_idx" ON "approval_policies" USING btree ("agent_id","tool_name","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_short_code_idx" ON "approvals" USING btree ("short_code") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_bindings_channel_external_idx" ON "channel_bindings" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "conversations_agent_idx" ON "conversations" USING btree ("agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "files_agent_idx" ON "files" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "goals_agent_status_idx" ON "goals" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_agent_category_idx" ON "memories" USING btree ("agent_id","category","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_message_id_idx" ON "messages" USING btree ("channel_message_id") WHERE "messages"."channel_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_embedding_idx" ON "messages" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "model_calls_created_idx" ON "model_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_calls_task_idx" ON "model_calls" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "schedules_enabled_next_idx" ON "schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_external_event_id_idx" ON "tasks" USING btree ("external_event_id") WHERE "tasks"."external_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_status_run_after_idx" ON "tasks" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "tasks_agent_status_idx" ON "tasks" USING btree ("agent_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "tool_cache_expires_idx" ON "tool_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_idempotency_key_idx" ON "tool_calls" USING btree ("idempotency_key") WHERE "tool_calls"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tool_calls_task_idx" ON "tool_calls" USING btree ("task_id","step");--> statement-breakpoint
CREATE INDEX "writing_samples_embedding_idx" ON "writing_samples" USING hnsw ("embedding" vector_cosine_ops);