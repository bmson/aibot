CREATE TABLE "notification_prefs" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"quiet_start_min" integer,
	"quiet_end_min" integer,
	"ambient_daily_cap" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_quiet_start_range" CHECK ("notification_prefs"."quiet_start_min" between 0 and 1439),
	CONSTRAINT "notification_prefs_quiet_end_range" CHECK ("notification_prefs"."quiet_end_min" between 0 and 1439),
	CONSTRAINT "notification_prefs_cap_positive" CHECK ("notification_prefs"."ambient_daily_cap" > 0)
);
--> statement-breakpoint
CREATE TABLE "proactive_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"urgency" text NOT NULL,
	"channel" text NOT NULL,
	"delivered" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_pings_urgency_check" CHECK ("proactive_pings"."urgency" IN ('ambient','interrupt'))
);
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_pings" ADD CONSTRAINT "proactive_pings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proactive_pings_agent_created_idx" ON "proactive_pings" USING btree ("agent_id","created_at");