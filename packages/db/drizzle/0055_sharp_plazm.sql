CREATE TABLE "recall_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"conversation_id" uuid,
	"path" text NOT NULL,
	"graph_attempted" boolean DEFAULT false NOT NULL,
	"graph_failed" boolean DEFAULT false NOT NULL,
	"graph_candidates" integer DEFAULT 0 NOT NULL,
	"graph_used" integer DEFAULT 0 NOT NULL,
	"history_tier" text DEFAULT 'none' NOT NULL,
	"history_used" integer DEFAULT 0 NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recall_metrics_path_check" CHECK ("recall_metrics"."path" IN ('chat','executor')),
	CONSTRAINT "recall_metrics_tier_check" CHECK ("recall_metrics"."history_tier" IN ('segment','message','none'))
);
--> statement-breakpoint
ALTER TABLE "recall_metrics" ADD CONSTRAINT "recall_metrics_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_metrics" ADD CONSTRAINT "recall_metrics_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_metrics" ADD CONSTRAINT "recall_metrics_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recall_metrics_agent_created_idx" ON "recall_metrics" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "recall_metrics_task_idx" ON "recall_metrics" USING btree ("task_id");