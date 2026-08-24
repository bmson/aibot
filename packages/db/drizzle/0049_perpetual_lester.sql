CREATE TABLE "knowledge_graph_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_graph_entities_kind_check" CHECK ("knowledge_graph_entities"."kind" IN ('person','organization','project','place','event','date','topic'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_graph_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"object_entity_id" uuid NOT NULL,
	"source_memory_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.70' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_graph_relations_predicate_check" CHECK (length("knowledge_graph_relations"."predicate") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "knowledge_graph_sources" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_graph_sources_status_check" CHECK ("knowledge_graph_sources"."status" IN ('pending','ready','failed'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_graph_entities" ADD CONSTRAINT "knowledge_graph_entities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_entities" ADD CONSTRAINT "knowledge_graph_entities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD CONSTRAINT "knowledge_graph_relations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD CONSTRAINT "knowledge_graph_relations_subject_entity_id_knowledge_graph_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."knowledge_graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD CONSTRAINT "knowledge_graph_relations_object_entity_id_knowledge_graph_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."knowledge_graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD CONSTRAINT "knowledge_graph_relations_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_sources" ADD CONSTRAINT "knowledge_graph_sources_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_graph_entities_agent_key_idx" ON "knowledge_graph_entities" USING btree ("agent_id","canonical_key");--> statement-breakpoint
CREATE INDEX "knowledge_graph_entities_contact_idx" ON "knowledge_graph_entities" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_graph_relations_source_ordinal_idx" ON "knowledge_graph_relations" USING btree ("source_memory_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_graph_relations_subject_idx" ON "knowledge_graph_relations" USING btree ("agent_id","subject_entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_graph_relations_object_idx" ON "knowledge_graph_relations" USING btree ("agent_id","object_entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_graph_sources_status_idx" ON "knowledge_graph_sources" USING btree ("status","updated_at");