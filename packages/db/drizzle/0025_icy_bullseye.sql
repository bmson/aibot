CREATE TABLE "occasions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"month" smallint NOT NULL,
	"day" smallint NOT NULL,
	"year" smallint,
	"recurrence" text DEFAULT 'annual' NOT NULL,
	"lead_days" smallint DEFAULT 7 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"origin_trust" text DEFAULT 'owner' NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"owner_confirmed" boolean DEFAULT false NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occasions_kind_check" CHECK ("occasions"."kind" IN ('birthday','anniversary','custom')),
	CONSTRAINT "occasions_recurrence_check" CHECK ("occasions"."recurrence" IN ('annual','once')),
	CONSTRAINT "occasions_month_check" CHECK ("occasions"."month" >= 1 AND "occasions"."month" <= 12),
	CONSTRAINT "occasions_day_check" CHECK ("occasions"."day" >= 1 AND "occasions"."day" <= 31),
	CONSTRAINT "occasions_origin_trust_check" CHECK ("occasions"."origin_trust" IN ('owner','known','unknown','assistant'))
);
--> statement-breakpoint
ALTER TABLE "occasions" ADD CONSTRAINT "occasions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occasions" ADD CONSTRAINT "occasions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "occasions_dedup_idx" ON "occasions" USING btree ("agent_id","contact_id","kind","month","day");--> statement-breakpoint
CREATE INDEX "occasions_contact_idx" ON "occasions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "occasions_month_day_idx" ON "occasions" USING btree ("month","day");