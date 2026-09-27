CREATE TABLE "call_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tool_call_id" uuid NOT NULL,
	"status" text NOT NULL,
	"to" text NOT NULL,
	"contact_name" text,
	"brief" jsonb NOT NULL,
	"voice_model" text NOT NULL,
	"max_minutes" integer NOT NULL,
	"twilio_call_sid" text,
	"stream_token_hash" text,
	"callback_token" text NOT NULL,
	"reservation_id" text,
	"answered_by" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checkins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hangup_requested" boolean DEFAULT false NOT NULL,
	"outcome" text,
	"summary" text,
	"cost_usd" numeric(12, 6),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_sessions_status_check" CHECK ("call_sessions"."status" IN ('dialing','ringing','in_progress','completed','no_answer','busy','failed','canceled'))
);
--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_sessions_agent_created_idx" ON "call_sessions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "call_sessions_twilio_sid_idx" ON "call_sessions" USING btree ("twilio_call_sid");