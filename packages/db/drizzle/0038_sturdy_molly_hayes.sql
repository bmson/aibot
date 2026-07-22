ALTER TABLE "tasks" ADD COLUMN "attention_notified_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: treat every task already parked for the owner as already-notified so
-- the new re-notify sweep does not fire a one-time burst of stale notices on deploy.
UPDATE "tasks" SET "attention_notified_at" = "updated_at" WHERE "status" IN ('needs_attention','waiting_event');