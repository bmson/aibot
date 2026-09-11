CREATE TABLE "calendar_event_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"event_id" text NOT NULL,
	"ical_uid" text,
	"summary" text DEFAULT '' NOT NULL,
	"start" text NOT NULL,
	"end" text NOT NULL,
	"status" text,
	"attendee_response_hash" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_snapshots_status_check" CHECK ("calendar_event_snapshots"."status" IS NULL OR "calendar_event_snapshots"."status" IN ('confirmed','tentative','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "calendar_event_snapshots" ADD CONSTRAINT "calendar_event_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_snapshots_event_idx" ON "calendar_event_snapshots" USING btree ("agent_id","calendar_id","event_id");--> statement-breakpoint
CREATE INDEX "calendar_event_snapshots_agent_updated_idx" ON "calendar_event_snapshots" USING btree ("agent_id","updated_at");