CREATE TABLE "import_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"source" text NOT NULL,
	"workspace_path" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_id" uuid,
	"items_total" integer,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"memories_saved" integer DEFAULT 0 NOT NULL,
	"memories_quarantined" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_sources_source_unique" UNIQUE("source"),
	CONSTRAINT "import_sources_kind_check" CHECK ("import_sources"."kind" IN ('mbox','json','text')),
	CONSTRAINT "import_sources_status_check" CHECK ("import_sources"."status" IN ('pending','running','done','failed','purged'))
);
--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;