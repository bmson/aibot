ALTER TABLE "goals" ADD COLUMN "autonomy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "autonomy_grant" jsonb;