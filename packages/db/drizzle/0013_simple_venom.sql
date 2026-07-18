CREATE TABLE "application_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_task_id" uuid NOT NULL,
	"conversation_id" uuid,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"expected_sender_emails" text[] NOT NULL,
	"confirmation_token_hash" text NOT NULL,
	"confirmation_token_hint" text NOT NULL,
	"tracker_update" jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_confirmation' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmation_message_id" text,
	"confirmation_from" text,
	"confirmed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_confirmations_status_check" CHECK ("application_confirmations"."status" IN ('awaiting_confirmation','confirmation_received','updated','update_unknown','update_failed','cancelled','expired'))
);
--> statement-breakpoint
ALTER TABLE "application_confirmations" ADD CONSTRAINT "application_confirmations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_confirmations" ADD CONSTRAINT "application_confirmations_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_confirmations" ADD CONSTRAINT "application_confirmations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_confirmations_message_idx" ON "application_confirmations" USING btree ("confirmation_message_id") WHERE "application_confirmations"."confirmation_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "application_confirmations_active_token_idx" ON "application_confirmations" USING btree ("agent_id","confirmation_token_hash") WHERE "application_confirmations"."status" = 'awaiting_confirmation';--> statement-breakpoint
CREATE INDEX "application_confirmations_pending_idx" ON "application_confirmations" USING btree ("agent_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "application_confirmations_source_task_idx" ON "application_confirmations" USING btree ("source_task_id");