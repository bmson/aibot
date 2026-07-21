CREATE TABLE "anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"policy_id" uuid,
	"tool_name" text NOT NULL,
	"observed" integer NOT NULL,
	"expected" integer DEFAULT 0 NOT NULL,
	"tool_call_ids" text[] DEFAULT '{}' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"window_label" text NOT NULL,
	"subject_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anomalies_kind_check" CHECK ("anomalies"."kind" IN ('frequency','off_hours','burst')),
	CONSTRAINT "anomalies_status_check" CHECK ("anomalies"."status" IN ('open','dismissed','suspended'))
);
--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anomalies_dedup_idx" ON "anomalies" USING btree ("agent_id","kind","subject_key","window_label");--> statement-breakpoint
CREATE INDEX "anomalies_status_idx" ON "anomalies" USING btree ("agent_id","status");