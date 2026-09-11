CREATE TABLE "model_call_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_call_id" uuid,
	"task_id" uuid,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"method" text NOT NULL,
	"capture" text NOT NULL,
	"system_prompt" text,
	"input" text,
	"output" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"finish_reason" text,
	"latency_ms" integer,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_call_audit_capture_check" CHECK ("model_call_audit"."capture" IN ('redacted','full'))
);
--> statement-breakpoint
ALTER TABLE "model_call_audit" ADD CONSTRAINT "model_call_audit_model_call_id_model_calls_id_fk" FOREIGN KEY ("model_call_id") REFERENCES "public"."model_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call_audit" ADD CONSTRAINT "model_call_audit_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_call_audit_created_idx" ON "model_call_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_call_audit_role_idx" ON "model_call_audit" USING btree ("role");--> statement-breakpoint
CREATE INDEX "model_call_audit_task_idx" ON "model_call_audit" USING btree ("task_id");