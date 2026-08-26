CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_message_id" uuid,
	"source_task_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"next_action" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"confidence" numeric(3, 2) DEFAULT '0.9' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitments_kind_check" CHECK ("commitments"."kind" IN ('decision','question','promise','waiting_on')),
	CONSTRAINT "commitments_status_check" CHECK ("commitments"."status" IN ('open','resolved','snoozed','dismissed','stale')),
	CONSTRAINT "commitments_confidence_check" CHECK ("commitments"."confidence" >= 0 AND "commitments"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_agent_hash_idx" ON "commitments" USING btree ("agent_id","content_hash");--> statement-breakpoint
CREATE INDEX "commitments_agent_status_idx" ON "commitments" USING btree ("agent_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "commitments_conversation_idx" ON "commitments" USING btree ("conversation_id","status","created_at");