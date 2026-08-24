CREATE TABLE "knowledge_graph_entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "knowledge_graph_relations_source_ordinal_idx";--> statement-breakpoint
ALTER TABLE "knowledge_graph_entities" ADD COLUMN "preferred_label" text;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
UPDATE "knowledge_graph_relations" SET "source_fingerprint" = 'legacy:' || "id"::text WHERE "source_fingerprint" IS NULL;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ALTER COLUMN "source_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD COLUMN "review_status" text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_graph_entity_aliases" ADD CONSTRAINT "knowledge_graph_entity_aliases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_entity_aliases" ADD CONSTRAINT "knowledge_graph_entity_aliases_entity_id_knowledge_graph_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."knowledge_graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_graph_entity_aliases_agent_key_idx" ON "knowledge_graph_entity_aliases" USING btree ("agent_id","canonical_key");--> statement-breakpoint
CREATE INDEX "knowledge_graph_entity_aliases_entity_idx" ON "knowledge_graph_entity_aliases" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_graph_relations_source_fingerprint_idx" ON "knowledge_graph_relations" USING btree ("source_memory_id","source_fingerprint");--> statement-breakpoint
CREATE INDEX "knowledge_graph_relations_review_idx" ON "knowledge_graph_relations" USING btree ("agent_id","review_status");--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD CONSTRAINT "knowledge_graph_relations_review_status_check" CHECK ("knowledge_graph_relations"."review_status" IN ('unreviewed','confirmed','rejected'));
