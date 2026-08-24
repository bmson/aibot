ALTER TABLE "knowledge_graph_relations" ADD COLUMN "evidence_quote" text;--> statement-breakpoint
ALTER TABLE "knowledge_graph_sources" ADD COLUMN "extraction_version" integer DEFAULT 1 NOT NULL;