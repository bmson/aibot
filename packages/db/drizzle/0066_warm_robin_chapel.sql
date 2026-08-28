CREATE TABLE "proactive_moments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"moment_key" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"pinged" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proactive_moments" ADD CONSTRAINT "proactive_moments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_moments_key_idx" ON "proactive_moments" USING btree ("agent_id","moment_key");--> statement-breakpoint
CREATE INDEX "proactive_moments_agent_delivered_idx" ON "proactive_moments" USING btree ("agent_id","delivered_at");