CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text DEFAULT 'checking' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"server_name" text,
	"server_version" text,
	"instructions" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connections_status_check" CHECK ("mcp_connections"."status" IN ('ready','checking','authorization_required','error','disabled'))
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_agent_name_idx" ON "mcp_connections" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "mcp_connections_agent_status_idx" ON "mcp_connections" USING btree ("agent_id","status");