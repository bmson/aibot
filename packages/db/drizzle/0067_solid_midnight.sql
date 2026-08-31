CREATE TABLE "generated_card_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"card_id" uuid NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"source_label" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"current_revision_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generated_cards_status_check" CHECK ("generated_cards"."status" IN ('active','dismissed','expired'))
);
--> statement-breakpoint
ALTER TABLE "generated_card_revisions" ADD CONSTRAINT "generated_card_revisions_card_id_generated_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."generated_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_cards" ADD CONSTRAINT "generated_cards_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_cards" ADD CONSTRAINT "generated_cards_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_cards" ADD CONSTRAINT "generated_cards_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_card_revisions_card_idx" ON "generated_card_revisions" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "generated_cards_agent_source_idx" ON "generated_cards" USING btree ("agent_id","source_fingerprint");--> statement-breakpoint
CREATE INDEX "generated_cards_agent_status_idx" ON "generated_cards" USING btree ("agent_id","status","updated_at");