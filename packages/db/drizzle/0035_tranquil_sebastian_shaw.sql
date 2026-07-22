CREATE TABLE "self_maintenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"proposal_id" uuid,
	"title" text NOT NULL,
	"diagnosis" text DEFAULT '' NOT NULL,
	"target_area" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'backlog' NOT NULL,
	"blocked_reason" text,
	"pr_number" integer,
	"pr_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_maintenance_status_check" CHECK ("self_maintenance"."status" IN ('backlog','blocked','pr_open','merged','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "self_maintenance" ADD CONSTRAINT "self_maintenance_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "self_maintenance_dedup_idx" ON "self_maintenance" USING btree ("agent_id","title");--> statement-breakpoint
CREATE INDEX "self_maintenance_status_idx" ON "self_maintenance" USING btree ("agent_id","status");