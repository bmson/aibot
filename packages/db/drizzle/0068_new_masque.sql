CREATE TABLE "situation_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"creation_key" text NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "situation_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"source_hash" text NOT NULL,
	"data" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "situation_preview_status" CHECK ("situation_previews"."status" IN ('pending','applied','dismissed'))
);
--> statement-breakpoint
ALTER TABLE "situation_packs" ADD CONSTRAINT "situation_packs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situation_previews" ADD CONSTRAINT "situation_previews_pack_id_situation_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."situation_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "situation_packs_creation_idx" ON "situation_packs" USING btree ("agent_id","creation_key");--> statement-breakpoint
CREATE INDEX "situation_packs_agent_idx" ON "situation_packs" USING btree ("agent_id","archived");