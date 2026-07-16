CREATE TABLE "memory_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_hash" text NOT NULL,
	"reason" text DEFAULT 'owner_forget' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_tombstones_content_hash_unique" UNIQUE("content_hash")
);
--> statement-breakpoint
CREATE TABLE "owner_card" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"compiled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_card_singleton_check" CHECK ("owner_card"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "subject_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "owner_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_subject_contact_id_contacts_id_fk" FOREIGN KEY ("subject_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_id_memories_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_subject_idx" ON "memories" USING btree ("subject_contact_id");--> statement-breakpoint
CREATE INDEX "memories_source_idx" ON "memories" USING btree ("source");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_domain_check" CHECK ("memories"."domain" IS NULL OR "memories"."domain" IN ('identity','work','home','relationships','preferences','health','other'));