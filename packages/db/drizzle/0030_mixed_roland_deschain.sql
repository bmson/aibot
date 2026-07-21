CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"title" text NOT NULL,
	"mime" text DEFAULT 'application/octet-stream' NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"source_ref" text DEFAULT '' NOT NULL,
	"trust" text DEFAULT 'owner' NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"extractor" text DEFAULT '' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" IN ('pending','extracting','ready','unsupported','failed')),
	CONSTRAINT "documents_trust_check" CHECK ("documents"."trust" IN ('owner','known','unknown','assistant'))
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_doc_idx" ON "document_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "document_chunks_agent_idx" ON "document_chunks" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_dedup_idx" ON "documents" USING btree ("agent_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_agent_status_idx" ON "documents" USING btree ("agent_id","status");