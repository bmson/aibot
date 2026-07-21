CREATE TABLE "improvement_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"change" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_ids" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "improvement_proposals_kind_check" CHECK ("improvement_proposals"."kind" IN ('model_role','policy','prompt','note')),
	CONSTRAINT "improvement_proposals_status_check" CHECK ("improvement_proposals"."status" IN ('open','applied','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "improvement_proposals" ADD CONSTRAINT "improvement_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "improvement_proposals_dedup_idx" ON "improvement_proposals" USING btree ("agent_id","kind","title");--> statement-breakpoint
CREATE INDEX "improvement_proposals_status_idx" ON "improvement_proposals" USING btree ("agent_id","status");