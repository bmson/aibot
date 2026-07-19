CREATE TABLE "watch_fires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger_ref" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"kind" text DEFAULT 'email' NOT NULL,
	"tier" text DEFAULT 'notify' NOT NULL,
	"name" text NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"fire_count" integer DEFAULT 0 NOT NULL,
	"max_fires" integer,
	"last_fired_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_kind_check" CHECK ("watches"."kind" IN ('email')),
	CONSTRAINT "watches_tier_check" CHECK ("watches"."tier" IN ('notify')),
	CONSTRAINT "watches_status_check" CHECK ("watches"."status" IN ('active','fired','expired','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "watch_fires" ADD CONSTRAINT "watch_fires_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_fires" ADD CONSTRAINT "watch_fires_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_fires_watch_trigger_idx" ON "watch_fires" USING btree ("watch_id","trigger_ref");--> statement-breakpoint
CREATE INDEX "watches_active_idx" ON "watches" USING btree ("agent_id","status","kind","expires_at");