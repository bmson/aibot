CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"task_id" uuid,
	"tool_call_id" uuid,
	"quantity" numeric(14, 4),
	"unit" text,
	"unit_price_usd" numeric(12, 8),
	"usd" numeric(10, 6) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"reservation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_events_source_check" CHECK ("cost_events"."source" IN ('model','embedding','twilio_sms','twilio_voice_min','cloud_run_job_sec','storage_gb_month','external_api'))
);
--> statement-breakpoint
CREATE TABLE "cost_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"source" text NOT NULL,
	"estimated_usd" numeric(10, 6) NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"actual_usd" numeric(10, 6),
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "cost_reservations_status_check" CHECK ("cost_reservations"."status" IN ('held','reconciled','released'))
);
--> statement-breakpoint
CREATE TABLE "rate_table" (
	"key" text PRIMARY KEY NOT NULL,
	"unit" text NOT NULL,
	"unit_price_usd" numeric(12, 8) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check";--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_reservation_id_cost_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."cost_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD CONSTRAINT "cost_reservations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_events_created_idx" ON "cost_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cost_events_task_idx" ON "cost_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "cost_events_source_idx" ON "cost_events" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "cost_reservations_status_idx" ON "cost_reservations" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('pending','running','waiting_approval','waiting_event','sleeping','waiting_budget','done','failed','needs_attention','cancelled'));