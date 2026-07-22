ALTER TABLE "documents" ADD COLUMN "processor_token_hash" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "processor_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "processed_text_path" text;