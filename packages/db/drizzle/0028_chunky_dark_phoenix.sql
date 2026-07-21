CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"preconditions" text DEFAULT '' NOT NULL,
	"steps" text NOT NULL,
	"gotchas" text DEFAULT '' NOT NULL,
	"embedding" vector(1536),
	"source_task_id" uuid,
	"origin_trust" text DEFAULT 'assistant' NOT NULL,
	"owner_authored" boolean DEFAULT false NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"deprecated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_origin_trust_check" CHECK ("skills"."origin_trust" IN ('owner','assistant'))
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_idx" ON "skills" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "skills_embedding_idx" ON "skills" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "skills_active_idx" ON "skills" USING btree ("agent_id","deprecated");