CREATE TABLE "assistant_health_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_health_alerts_status_check" CHECK ("assistant_health_alerts"."status" IN ('open','resolved'))
);
--> statement-breakpoint
ALTER TABLE "assistant_health_alerts" ADD CONSTRAINT "assistant_health_alerts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_health_alerts_agent_kind_idx" ON "assistant_health_alerts" USING btree ("agent_id","kind");--> statement-breakpoint
CREATE INDEX "assistant_health_alerts_open_idx" ON "assistant_health_alerts" USING btree ("agent_id","status","last_seen_at");