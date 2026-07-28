CREATE TABLE "response_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"prompt_version" integer NOT NULL,
	"planner_version" integer,
	"blocked" boolean DEFAULT false NOT NULL,
	"unsupported_count" integer DEFAULT 0 NOT NULL,
	"must_act_retries" integer DEFAULT 0 NOT NULL,
	"degraded_steps" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "response_checks" ADD CONSTRAINT "response_checks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "response_checks_task_idx" ON "response_checks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "response_checks_created_idx" ON "response_checks" USING btree ("created_at");