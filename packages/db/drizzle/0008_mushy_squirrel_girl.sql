CREATE TABLE "canary_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"ok" boolean,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"browser_callback_token_hash" text,
	"browser_result" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "canary_runs_status_check" CHECK ("canary_runs"."status" IN ('running','completed','failed'))
);
--> statement-breakpoint
CREATE INDEX "canary_runs_started_idx" ON "canary_runs" USING btree ("started_at");