CREATE TABLE "recall_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recall_feedback_verdict_check" CHECK ("recall_feedback"."verdict" IN ('helpful','not_helpful'))
);
--> statement-breakpoint
ALTER TABLE "recall_feedback" ADD CONSTRAINT "recall_feedback_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_feedback" ADD CONSTRAINT "recall_feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recall_feedback_message_idx" ON "recall_feedback" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "recall_feedback_agent_created_idx" ON "recall_feedback" USING btree ("agent_id","created_at");