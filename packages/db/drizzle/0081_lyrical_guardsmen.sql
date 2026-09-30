CREATE TABLE "self_repair_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'reported' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_repair_issues_status_check" CHECK ("self_repair_issues"."status" IN ('reported','investigating','fixing','testing','pr_open','merged','monitoring','resolved','blocked','failed','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "self_repair_issues" ADD CONSTRAINT "self_repair_issues_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "self_repair_issues_dedup_idx" ON "self_repair_issues" USING btree ("agent_id","fingerprint");--> statement-breakpoint
CREATE INDEX "self_repair_issues_owner_idx" ON "self_repair_issues" USING btree ("agent_id","status");