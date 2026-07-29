ALTER TABLE "watches" DROP CONSTRAINT "watches_kind_check";--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "next_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "poll_interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "watches_due_web_idx" ON "watches" USING btree ("status","kind","next_poll_at");--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_kind_check" CHECK ("watches"."kind" IN ('email','web'));