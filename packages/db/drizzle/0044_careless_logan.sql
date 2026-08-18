CREATE TABLE "email_ingest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"channel_message_id" text NOT NULL,
	"from_email" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"content_trust" text DEFAULT 'unknown' NOT NULL,
	"authenticated" boolean DEFAULT false NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"importance" smallint DEFAULT 1 NOT NULL,
	"actionable" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triaged" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_ingest_importance_check" CHECK ("email_ingest"."importance" BETWEEN 1 AND 5),
	CONSTRAINT "email_ingest_content_trust_check" CHECK ("email_ingest"."content_trust" IN ('owner','known','unknown'))
);
--> statement-breakpoint
ALTER TABLE "email_ingest" ADD CONSTRAINT "email_ingest_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD CONSTRAINT "email_ingest_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_ingest_message_idx" ON "email_ingest" USING btree ("channel_message_id");--> statement-breakpoint
CREATE INDEX "email_ingest_agent_created_idx" ON "email_ingest" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "email_ingest_extract_idx" ON "email_ingest" USING btree ("extracted_at","created_at");