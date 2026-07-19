CREATE TABLE "conversation_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"start_message_id" uuid NOT NULL,
	"end_message_id" uuid NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"embedding" vector(1536),
	"message_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_segments" ADD CONSTRAINT "conversation_segments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_segments" ADD CONSTRAINT "conversation_segments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_segments" ADD CONSTRAINT "conversation_segments_start_message_id_messages_id_fk" FOREIGN KEY ("start_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_segments" ADD CONSTRAINT "conversation_segments_end_message_id_messages_id_fk" FOREIGN KEY ("end_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_segments_embedding_idx" ON "conversation_segments" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "conversation_segments_conversation_idx" ON "conversation_segments" USING btree ("conversation_id","ended_at");--> statement-breakpoint
CREATE INDEX "conversation_segments_agent_idx" ON "conversation_segments" USING btree ("agent_id","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_segments_start_idx" ON "conversation_segments" USING btree ("conversation_id","start_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_primary_idx" ON "conversations" USING btree ("agent_id") WHERE "conversations"."is_primary";