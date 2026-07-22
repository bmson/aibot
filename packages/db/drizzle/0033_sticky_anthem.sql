CREATE TABLE "ambient_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"block" text DEFAULT '' NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ambient_snapshots_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
ALTER TABLE "ambient_snapshots" ADD CONSTRAINT "ambient_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;